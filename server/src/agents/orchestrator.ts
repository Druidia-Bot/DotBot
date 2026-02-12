/**
 * V2 Orchestrator — Spawned Agent Pipeline
 *
 * The V2 entry point for request execution. Replaces the V1 pipeline
 * for requests that need conversation isolation and per-agent tool slicing.
 *
 * Flow:
 * 1. Short path check (greetings, acks — skip everything)
 * 2. Receptionist classifies request (reuses existing runReceptionist)
 * 3. Persona writer creates dynamic personas + tool selections
 * 4. For each task: spawn an agent with isolated conversation + curated tools
 * 5. Supervisor monitors active agents
 * 6. Enhanced judge evaluates each result
 * 7. Reflector runs post-task analysis (background)
 * 8. Merge responses into main feed with agent labels
 *
 * This runs ALONGSIDE the V1 pipeline — not replacing it. The pipeline
 * dispatcher decides which path to use based on feature flags or request type.
 */

import { createComponentLogger } from "../logging.js";
import { SpawnedAgent } from "./spawned-agent.js";
import { MessageRouter } from "./message-router.js";
import { executeWithPersona } from "./execution.js";
import { runEnhancedJudge } from "./judge.js";
import { AgentSupervisor } from "./supervisor.js";
import { runReflectorAsync } from "./reflector.js";
import { handleEscalation } from "./architect.js";
import {
  createWorkspace,
  saveTaskJson,
  completeTask,
  appendToolCallLog,
  scheduleWorkspaceCleanup,
  type AgentWorkspace,
  type TaskJson,
} from "./workspace.js";
import type { ILLMClient } from "../llm/providers.js";
import type { AgentRunnerOptions } from "./runner-types.js";
import type { EnhancedPromptRequest } from "../types/agent.js";

const log = createComponentLogger("orchestrator");

// ============================================
// TYPES
// ============================================

/** Describes a task for a spawned agent, produced by the receptionist/orchestrator. */
export interface AgentTask {
  /** What the agent should do */
  task: string;
  /** Short topic label */
  topic: string;
  /** Custom system prompt for this agent */
  systemPrompt: string;
  /** Tool IDs from the compact catalog */
  selectedToolIds: string[];
  /** Model role hint */
  modelRole?: "workhorse" | "deep_context" | "architect" | "gui_fast";
  /** Indices of main-feed messages relevant to this task */
  relevantMessageIndices?: number[];
}

export interface OrchestratorResult {
  success: boolean;
  /** Combined response from all agents */
  response: string;
  /** Individual agent results */
  agentResults: Array<{
    agentId: string;
    topic: string;
    response: string;
    status: string;
    workLog?: string;
  }>;
  /** The message router for this session (can be reused for follow-ups) */
  router: MessageRouter;
}

// ============================================
// ORCHESTRATOR
// ============================================

/**
 * Execute one or more tasks using spawned agents with conversation isolation.
 *
 * This is the V2 equivalent of executeFullPipeline. It takes pre-decomposed
 * tasks (from the persona writer) and runs them as isolated agents.
 */
export async function executeWithSpawnedAgents(
  llm: ILLMClient,
  options: AgentRunnerOptions,
  request: EnhancedPromptRequest,
  tasks: AgentTask[],
  router?: MessageRouter
): Promise<OrchestratorResult> {
  const messageRouter = router || new MessageRouter();

  log.info("Spawning agents", {
    taskCount: tasks.length,
    topics: tasks.map(t => t.topic),
  });

  // Create spawned agents for each task and wire message routing
  const agents: SpawnedAgent[] = [];
  for (const task of tasks) {
    const agent = new SpawnedAgent({
      task: task.task,
      topic: task.topic,
      systemPrompt: task.systemPrompt,
      selectedToolIds: task.selectedToolIds,
      relevantMessageIndices: task.relevantMessageIndices,
      modelRole: task.modelRole,
    });
    agents.push(agent);
    messageRouter.registerAgent(agent);

    // Wire message routing: assign relevant messages to this agent
    if (task.relevantMessageIndices && task.relevantMessageIndices.length > 0) {
      for (const idx of task.relevantMessageIndices) {
        messageRouter.assignMessage(idx, agent.id, agent.topic);
      }
    }

    // Build isolated conversation history for this agent
    const isolatedHistory = messageRouter.getMessagesForAgent(
      agent.id,
      request.recentHistory
    );

    // Add isolated messages to agent's conversation
    for (const msg of isolatedHistory) {
      agent.addMessage({
        role: msg.role,
        content: msg.content,
      });
    }
  }

  // Per-agent injection queues and abort controllers for supervisor intervention
  const agentInjectionQueues = new Map<string, string[]>();
  const agentAbortControllers = new Map<string, AbortController>();
  for (const agent of agents) {
    agentInjectionQueues.set(agent.id, []);
    agentAbortControllers.set(agent.id, new AbortController());
  }

  // Start supervisor — fully wired with injection + abort + status reporting
  const supervisor = new AgentSupervisor({
    onInjectMessage: (agentId, message) => {
      const queue = agentInjectionQueues.get(agentId);
      if (queue) {
        queue.push(message);
        log.info("Supervisor injected message into agent queue", { agentId, queueLength: queue.length });
      }
    },
    onAbortAgent: (agentId, reason) => {
      const controller = agentAbortControllers.get(agentId);
      if (controller) {
        controller.abort();
        log.info("Supervisor aborted agent", { agentId, reason });
      }
    },
    onStatusReport: (report) => {
      log.info("Supervisor report", { agentId: report.agentId, status: report.status, message: report.message });
      if (options.onStream) {
        options.onStream("supervisor", `[${report.topic}] ${report.message}\n`, false);
      }
    },
  });
  supervisor.watch(agents);

  // Execute all agents
  // Sequential execution — parallel agents would interleave streaming chunks
  // on the same WebSocket, causing garbled client output. Enable parallelism
  // once per-agent stream multiplexing is implemented.
  const agentResults: OrchestratorResult["agentResults"] = [];
  const startTime = Date.now();

  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    const task = tasks[i];
    agent.start();

    // Notify client that a spawned agent has started
    options.onAgentStarted?.({
      agentId: agent.id,
      topic: agent.topic,
      agentRole: task.topic,
      toolCount: task.selectedToolIds.length,
    });

    // Create workspace on client (fire-and-forget — don't block agent on dir creation)
    let workspace: AgentWorkspace | null = null;
    let taskJson: TaskJson | null = null;
    if (options.onExecuteCommand) {
      try {
        const { workspace: ws, setupCommands } = createWorkspace(agent.id);
        workspace = ws;
        for (const cmd of setupCommands) {
          options.onExecuteCommand({
            id: `ws_${agent.id}_${cmd.toolId}`,
            type: "tool_execute",
            payload: { toolId: cmd.toolId, toolArgs: cmd.args },
            dryRun: false, timeout: 10000, sandboxed: false, requiresApproval: false,
          }).catch((err) => {
            log.warn("Workspace setup command failed", { agentId: agent.id, cmd: cmd.toolId, error: err });
          }); // non-blocking but logged
        }

        // Save initial task.json
        taskJson = {
          taskId: agent.id,
          topic: agent.topic,
          createdAt: new Date().toISOString(),
          status: "running",
          lastActiveAt: new Date().toISOString(),
          persona: {
            systemPrompt: agent.systemPrompt.substring(0, 500),
            role: task.topic,
            temperature: 0.5,
            maxIterations: 50,
            modelTier: task.modelRole || "workhorse",
          },
          selectedToolIds: task.selectedToolIds,
          conversation: [],
          progress: { stepsCompleted: [], currentStep: "Starting" },
          originalMessageIndices: task.relevantMessageIndices || [],
        };
        const saveCmd = saveTaskJson(workspace, taskJson);
        options.onExecuteCommand({
          id: `ws_${agent.id}_task_json`,
          type: "tool_execute",
          payload: { toolId: saveCmd.toolId, toolArgs: saveCmd.args },
          dryRun: false, timeout: 10000, sandboxed: false, requiresApproval: false,
        }).catch((err) => {
          log.warn("Failed to save initial task.json", { agentId: agent.id, error: err });
        });
      } catch (err) {
        log.warn("Workspace setup failed (non-fatal)", { agentId: agent.id, error: err });
      }
    }

    try {
      const injectionQueue = agentInjectionQueues.get(agent.id);
      const abortController = agentAbortControllers.get(agent.id)!;
      let result = await executeAgent(llm, options, request, agent, injectionQueue, abortController);

      // Handle escalation — agent realized it needs different tools/approach
      if (result.escalated) {
        log.info("Agent escalated — invoking architect", {
          agentId: agent.id,
          topic: agent.topic,
          reason: result.escalationReason,
        });

        const architectDecision = await handleEscalation(llm, options, {
          agentId: agent.id,
          topic: agent.topic,
          originalPrompt: request.prompt,
          escalationReason: result.escalationReason || "Agent needs different tools",
          suggestedApproach: undefined,
          workLog: result.workLog,
          agentSystemPrompt: agent.systemPrompt,
          agentToolIds: agent.selectedToolIds,
        });

        if (architectDecision.action === "rewrite" && architectDecision.tasks.length > 0) {
          // Rewrite: update the agent's config and re-execute
          const newTask = architectDecision.tasks[0];
          const rewrittenAgent = new SpawnedAgent({
            task: newTask.task,
            topic: newTask.topic,
            systemPrompt: newTask.systemPrompt,
            selectedToolIds: newTask.selectedToolIds,
            modelRole: newTask.modelRole as any,
          });
          rewrittenAgent.start();
          result = await executeAgent(llm, options, request, rewrittenAgent);
        } else if (architectDecision.action === "decompose" && architectDecision.tasks.length > 1) {
          // Decompose: execute sub-tasks sequentially, merge results
          const subResults: string[] = [];
          for (const subTask of architectDecision.tasks) {
            const subAgent = new SpawnedAgent({
              task: subTask.task,
              topic: subTask.topic,
              systemPrompt: subTask.systemPrompt,
              selectedToolIds: subTask.selectedToolIds,
              modelRole: subTask.modelRole as any,
            });
            subAgent.start();
            const subResult = await executeAgent(llm, options, request, subAgent);
            subResults.push(`**${subTask.topic}:** ${subResult.response}`);
          }
          result = { response: subResults.join("\n\n"), workLog: result.workLog + "\n[Architect decomposed into sub-tasks]" };
        } else if (architectDecision.action === "abort") {
          // Abort: use architect's message
          result = { response: architectDecision.abortMessage || result.response, workLog: result.workLog };
        }
      }

      // Run enhanced judge on the result
      const judgeResult = await runEnhancedJudge(llm, options, {
        originalPrompt: request.prompt,
        proposedResponse: result.response,
        agentId: agent.topic,
        toolCallSummary: result.workLog,
      });

      let finalResponse = judgeResult.response;
      if (judgeResult.verdict.verdict === "rerun") {
        log.info("Enhanced judge requested rerun", { agentId: agent.id, topic: agent.topic, scores: judgeResult.verdict.scores });

        // Reset agent status for retry
        agent.start();

        const retryResult = await executeAgent(llm, options, request, agent, injectionQueue, abortController);
        const retryJudge = await runEnhancedJudge(llm, options, {
          originalPrompt: request.prompt,
          proposedResponse: retryResult.response,
          agentId: agent.topic,
          toolCallSummary: retryResult.workLog,
          isRetry: true,
        });

        // Check if retry judge aborted - use abort message instead of retry response
        if (retryJudge.verdict.verdict === "abort") {
          log.warn("Enhanced judge aborted after retry", { agentId: agent.id, topic: agent.topic });
          finalResponse = retryJudge.response; // This is the abort error message
        } else {
          finalResponse = retryJudge.response;
        }
      }

      agent.complete(finalResponse);
      agentResults.push({
        agentId: agent.id,
        topic: agent.topic,
        response: finalResponse,
        status: "completed",
        workLog: result.workLog,
      });

      // Notify client that the spawned agent completed
      options.onAgentComplete?.({
        agentId: agent.id,
        topic: agent.topic,
        agentRole: task.topic,
        success: true,
        response: finalResponse,
      });

      // Write tool call log to workspace (logs/tool-calls.jsonl)
      if (workspace && options.onExecuteCommand && result.toolCallsMade?.length) {
        for (const tc of result.toolCallsMade) {
          const logCmd = appendToolCallLog(workspace, {
            ts: new Date().toISOString(),
            tool: tc.tool,
            input: tc.args,
            result: tc.result.substring(0, 2000),
            durationMs: 0, // Duration not tracked per-call in V2 yet
          });
          options.onExecuteCommand({
            id: `ws_${agent.id}_log_${tc.tool}`,
            type: "tool_execute",
            payload: { toolId: logCmd.toolId, toolArgs: logCmd.args },
            dryRun: false, timeout: 5000, sandboxed: false, requiresApproval: false,
          }).catch((err) => {
            log.warn("Failed to log tool call", { agentId: agent.id, tool: tc.tool, error: err });
          }); // non-blocking but logged
        }
      }

      // Delete task.json to mark completion (workspace folder stays for cleanup later)
      if (workspace && options.onExecuteCommand) {
        const delCmd = completeTask(workspace);
        options.onExecuteCommand({
          id: `ws_${agent.id}_complete`,
          type: "tool_execute",
          payload: { toolId: delCmd.toolId, toolArgs: delCmd.args },
          dryRun: false, timeout: 10000, sandboxed: false, requiresApproval: false,
        }).catch((err) => {
          log.warn("Failed to delete task.json on completion", { agentId: agent.id, error: err });
        });

        // Schedule workspace cleanup in 1 hour
        scheduleWorkspaceCleanup(agent.id);
      }

      // Run reflector in background (non-blocking)
      runReflectorAsync(llm, options, {
        originalPrompt: request.prompt,
        finalResponse,
        agentId: agent.topic,
        toolCallSummary: result.workLog,
        iterations: 0,
        executionTimeMs: Date.now() - startTime,
        judgeVerdict: judgeResult.verdict.verdict,
      });

    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      agent.fail(errMsg);
      log.error("Agent execution failed", { agentId: agent.id, topic: agent.topic, error: errMsg });
      agentResults.push({
        agentId: agent.id,
        topic: agent.topic,
        response: `Failed: ${errMsg}`,
        status: "failed",
      });

      // Notify client of failure
      options.onAgentComplete?.({
        agentId: agent.id,
        topic: agent.topic,
        agentRole: task.topic,
        success: false,
        response: errMsg,
      });

      // Update task.json with failure status (don't delete — allows resumption)
      if (workspace && taskJson && options.onExecuteCommand) {
        taskJson.status = "failed";
        taskJson.failureReason = errMsg;
        const failCmd = saveTaskJson(workspace, taskJson);
        options.onExecuteCommand({
          id: `ws_${agent.id}_fail`,
          type: "tool_execute",
          payload: { toolId: failCmd.toolId, toolArgs: failCmd.args },
          dryRun: false, timeout: 10000, sandboxed: false, requiresApproval: false,
        }).catch((err) => {
          log.warn("Failed to update task.json with failure status", { agentId: agent.id, error: err });
        });
      }
    }
  }

  // Stop supervisor
  supervisor.stop();

  // Merge responses
  const response = mergeAgentResponses(agentResults);

  return {
    success: agentResults.some(r => r.status === "completed"),
    response,
    agentResults,
    router: messageRouter,
  };
}

// ============================================
// AGENT EXECUTION
// ============================================

/**
 * Execute a single spawned agent using the tool loop.
 * Builds an ad-hoc PersonaDefinition from the agent's config and
 * passes the agent's selected tool IDs for manifest slicing.
 */
async function executeAgent(
  llm: ILLMClient,
  options: AgentRunnerOptions,
  request: EnhancedPromptRequest,
  agent: SpawnedAgent,
  injectionQueue?: string[],
  abortController?: AbortController
): Promise<{ response: string; workLog: string; escalated?: boolean; escalationReason?: string; neededToolCategories?: string[]; toolCallsMade?: { tool: string; args: Record<string, any>; result: string; success: boolean }[] }> {
  // Build an ad-hoc persona from the agent's dynamic config
  const persona = {
    id: agent.id,
    name: agent.topic,
    type: "dynamic" as const,
    description: agent.task,
    systemPrompt: agent.systemPrompt,
    modelTier: "fast" as const,
    tools: ["all"], // We control tools via selectedToolIds, not categories
    modelRole: agent.modelRole as any,
  };

  log.info("Executing agent", {
    agentId: agent.id,
    topic: agent.topic,
    toolCount: agent.selectedToolIds.length,
    modelRole: agent.modelRole,
    isolatedHistoryLength: agent.getConversation().length,
  });

  // Build isolated request with only this agent's conversation history
  const isolatedRequest: EnhancedPromptRequest = {
    ...request,
    // Use agent's isolated conversation history instead of full recent history
    recentHistory: agent.getConversation().map(msg => ({
      role: msg.role as "user" | "assistant",
      content: msg.content,
    })),
  };

  // Wire synthetic tool callbacks in augmented options
  const augmentedOptions: AgentRunnerOptions & {
    onRequestTools?: (categories: string[]) => string[];
    onRequestResearch?: (query: string, depth: string, format: string) => Promise<string>;
  } = {
    ...options,
    onRequestTools: (categories: string[]): string[] => {
      log.info("Agent requesting additional tools", { agentId: agent.id, categories });

      // Filter tool manifest by requested categories
      if (!options.toolManifest || options.toolManifest.length === 0) {
        log.warn("No tool manifest available for tool expansion", { agentId: agent.id });
        return [];
      }

      const categorySet = new Set(categories.map(c => c.toLowerCase()));
      const newToolIds = options.toolManifest
        .filter(t => {
          const toolCategory = (t.category || "").toLowerCase();
          return categorySet.has(toolCategory);
        })
        .map(t => t.id);

      // Add new tool IDs to agent's selected tools (avoid duplicates)
      const currentToolSet = new Set(agent.selectedToolIds);
      const addedTools = newToolIds.filter(id => !currentToolSet.has(id));

      if (addedTools.length > 0) {
        agent.selectedToolIds.push(...addedTools);
        log.info("Expanded agent tool access", {
          agentId: agent.id,
          categories,
          addedCount: addedTools.length,
          newTotal: agent.selectedToolIds.length,
        });
      } else {
        log.info("No new tools matched requested categories", { agentId: agent.id, categories });
      }

      return addedTools;
    },
    onRequestResearch: async (query: string, depth: string, format: string): Promise<string> => {
      log.info("Agent requesting research", { agentId: agent.id, query, depth, format });

      // Import research protocol
      const { createResearchTask, parseResearchRequest } = await import("./research-protocol.js");

      // Create research request
      const researchRequest = parseResearchRequest(agent.id, {
        query,
        depth: depth || "moderate",
        format: format || "markdown",
      });

      // Create research task
      const researchTask = createResearchTask(researchRequest);

      // Spawn research sub-agent (reuse orchestrator's own spawnAndRun logic)
      const researchAgent = new SpawnedAgent({
        task: researchTask.task,
        topic: researchTask.topic,
        systemPrompt: researchTask.systemPrompt,
        selectedToolIds: researchTask.selectedToolIds,
        modelRole: researchTask.modelRole || "workhorse",
        relevantMessageIndices: [],
      });

      researchAgent.start();
      log.info("Research sub-agent spawned", {
        parentAgent: agent.id,
        researchAgent: researchAgent.id,
        query: query.substring(0, 100),
      });

      // Execute research agent
      try {
        const agentResult = await executeWithPersona(
          llm,
          options,
          persona,
          researchAgent.task,
          isolatedRequest,
          injectionQueue,
          abortController ? () => abortController.signal : undefined,
          researchAgent.modelRole || "workhorse",
          undefined,
          undefined,
          researchAgent.selectedToolIds
        );

        researchAgent.complete(agentResult.response);

        // Write research findings to parent agent's workspace
        try {
          const { writeResearchFindings } = await import("./workspace.js");

          // Extract URLs from response as sources
          const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
          const sources = [...new Set(agentResult.response.match(urlRegex) || [])];

          const cmd = writeResearchFindings(agent.id, {
            query,
            findings: agentResult.response,
            sources,
            completedAt: new Date(),
          });

          if (options.onExecuteCommand) {
            await options.onExecuteCommand({
              id: `research_${agent.id}_${Date.now()}`,
              type: "tool_execute",
              payload: { toolId: cmd.toolId, toolArgs: cmd.args },
              dryRun: false,
              timeout: 10000,
              sandboxed: false,
              requiresApproval: false,
            }).catch((err) => {
              log.warn("Failed to write research findings", { agentId: agent.id, error: err });
            });
          }
        } catch (workspaceErr) {
          log.warn("Failed to write research findings to workspace", {
            agentId: agent.id,
            error: workspaceErr,
          });
        }

        return agentResult.response;
      } catch (error) {
        researchAgent.fail(error instanceof Error ? error.message : String(error));
        log.error("Research sub-agent failed", {
          parentAgent: agent.id,
          researchAgent: researchAgent.id,
          error,
        });
        return `Research failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };

  const onWaitForUser = async (reason: string, resumeHint?: string, timeoutMs?: number): Promise<string> => {
    log.warn("Agent requested user input (not yet implemented)", {
      agentId: agent.id,
      reason,
      resumeHint,
      timeoutMs
    });
    agent.block();

    // Future: Send user_input_request via WS, wait for user_input_response
    // For now, agents should use agent.escalate instead of waiting for input
    return `[User input blocking not yet supported. Please rephrase your request or use agent.escalate to get help from a supervisor agent.]`;
  };

  // Execute with persona, passing selectedToolIds for V2 manifest slicing
  const result = await executeWithPersona(
    llm,
    augmentedOptions,
    persona,
    agent.task,
    isolatedRequest,
    injectionQueue,
    abortController ? () => abortController.signal : undefined,
    agent.modelRole,
    undefined,  // extraToolCategories (not needed — we use selectedToolIds)
    onWaitForUser,
    agent.selectedToolIds  // V2: ID-based tool slicing
  );

  return result;
}

// ============================================
// RESPONSE MERGING
// ============================================

/**
 * Merge multiple agent responses into a single coherent response.
 * For single agents: just return the response.
 * For multiple: label each section with the agent's topic.
 */
function mergeAgentResponses(
  results: OrchestratorResult["agentResults"]
): string {
  const completed = results.filter(r => r.status === "completed");

  if (completed.length === 0) {
    return "I wasn't able to complete any of the tasks. " +
      results.map(r => `${r.topic}: ${r.response}`).join("\n");
  }

  if (completed.length === 1) {
    return completed[0].response;
  }

  // Multiple agents — label each section
  return completed
    .map(r => `**${r.topic}:**\n${r.response}`)
    .join("\n\n---\n\n");
}
