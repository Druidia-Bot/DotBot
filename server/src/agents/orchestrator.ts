/**
 * Orchestrator — Spawned Agent Pipeline
 *
 * Executes tasks produced by the persona writer as isolated spawned agents.
 * Each agent gets its own conversation, workspace, tool set, and supervisor.
 *
 * Flow:
 * 1. Create spawned agents from AgentTask[] (from persona writer)
 * 2. Wire message routing for conversation isolation
 * 3. Set up per-agent workspaces (or reuse continuation workspace)
 * 4. Execute each agent via tool loop
 * 5. Supervisor monitors active agents
 * 6. Enhanced judge evaluates each result
 * 7. Reflector runs post-task analysis (background)
 * 8. Merge responses and return
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
  saveResearchOutput,
  completeTask,
  appendToolCallLog,
  appendExecutionJournal,
  saveConversationLog,
  scheduleWorkspaceCleanup,
  type AgentWorkspace,
  type TaskJson,
  type ExecutionJournalEntry,
} from "./workspace.js";
import type { ILLMClient } from "../llm/providers.js";
import { createLLMClient, getApiKeyForProvider } from "../llm/providers.js";
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

/**
 * Context from a previous agent's completed work.
 * Passed when a follow-up message matches a completed agent — the new agent
 * reuses the same workspace so it has access to research files, downloads, etc.
 */
export interface ContinuationContext {
  /** Previous agent's workspace (reused instead of creating a new one) */
  workspace: AgentWorkspace;
  /** Previous agent's task state (conversation, progress, status) */
  taskJson: TaskJson;
  /** Previous agent's final response */
  previousResponse: string;
  /** Previous agent's ID (for logging) */
  previousAgentId: string;
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
  /** Injection queues for each agent (enables mid-execution message injection) */
  injectionQueues: Map<string, string[]>;
  /** Workspaces for each agent (enables real-time task.json updates) */
  workspaces: Map<string, import("./workspace.js").AgentWorkspace>;
  /** TaskJson state for each agent (enables real-time updates without re-reading from client) */
  taskJsonState: Map<string, import("./workspace.js").TaskJson>;
  /** Wait resolvers for blocked agents — call resolver(message) to unblock an agent
   *  that called agent.wait_for_user. The promise in the tool loop resolves with the message. */
  waitResolvers: Map<string, (message: string) => void>;
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
  router?: MessageRouter,
  conversationSnapshot?: string[],
  onOrchestratorReady?: (result: OrchestratorResult) => void,
  continuationContext?: ContinuationContext
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

  // Per-agent injection queues, workspaces, task state, abort controllers, and wait resolvers
  const agentInjectionQueues = new Map<string, string[]>();
  const agentWorkspaces = new Map<string, AgentWorkspace>();
  const agentTaskJsonState = new Map<string, TaskJson>();
  const agentAbortControllers = new Map<string, AbortController>();
  const agentWaitResolvers = new Map<string, (message: string) => void>();
  for (const agent of agents) {
    agentInjectionQueues.set(agent.id, []);
    agentAbortControllers.set(agent.id, new AbortController());
  }

  // Per-agent execution journals (collected during execution, written to workspace on completion)
  const agentJournals = new Map<string, ExecutionJournalEntry[]>();
  for (const agent of agents) {
    agentJournals.set(agent.id, []);
  }

  // Start supervisor — fully wired with injection + abort + status reporting + journal
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
      // Journal: supervisor abort
      agentJournals.get(agentId)?.push({
        ts: new Date().toISOString(), agentId, type: "supervisor",
        supervisor: { status: "aborted", action: "abort", message: reason },
      });
    },
    onStatusReport: (report) => {
      log.info("Supervisor report", { agentId: report.agentId, status: report.status, message: report.message });
      if (options.onStream) {
        options.onStream("supervisor", `[${report.topic}] ${report.message}\n`, false);
      }
      // Journal: supervisor status event
      agentJournals.get(report.agentId)?.push({
        ts: new Date().toISOString(), agentId: report.agentId, type: "supervisor",
        supervisor: { status: report.status, action: report.status === "stuck" ? "inject_message" : "watch", message: report.message, timeSinceActivityMs: report.elapsedMs },
      });
    },
  });
  supervisor.watch(agents);

  // Build the result object early — the Maps are live references, so concurrent
  // callers can use them for injection even while agents are still executing.
  const earlyResult: OrchestratorResult = {
    success: false, // Updated on completion
    response: "",   // Updated on completion
    agentResults: [], // Populated during execution
    router: messageRouter,
    injectionQueues: agentInjectionQueues,
    workspaces: agentWorkspaces,
    taskJsonState: agentTaskJsonState,
    waitResolvers: agentWaitResolvers,
  };

  // Notify the caller that agents are spawned and injection infrastructure is live.
  // This allows concurrent pipeline calls to find running agents and inject messages.
  onOrchestratorReady?.(earlyResult);

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

    // Create workspace on client — await directory creation before writing files
    // If this is the first agent and we have continuation context, reuse the previous workspace
    const isContinuation = i === 0 && continuationContext;
    let workspace: AgentWorkspace | null = null;
    let taskJson: TaskJson | null = null;
    if (options.onExecuteCommand) {
      try {
        if (isContinuation) {
          // Reuse the previous agent's workspace — directories + research files already exist
          workspace = continuationContext.workspace;
          agentWorkspaces.set(agent.id, workspace);
          log.info("Reusing previous workspace for continuation", {
            agentId: agent.id,
            previousAgentId: continuationContext.previousAgentId,
            workspacePath: workspace.basePath,
          });

          // Inject previous work context into the agent's conversation so it knows what was already done
          const prevTaskJson = continuationContext.taskJson;
          const prevConversation = prevTaskJson.conversation || [];
          const prevSteps = prevTaskJson.progress?.stepsCompleted || [];
          const contextSummary = [
            `## Continuation from previous agent (${continuationContext.previousAgentId})`,
            `**Topic:** ${prevTaskJson.topic}`,
            `**Status:** ${prevTaskJson.status}`,
            prevSteps.length > 0 ? `**Steps completed:** ${prevSteps.join(", ")}` : "",
            `**Workspace:** ${workspace.basePath} (research files, downloads, and artifacts from previous work are here)`,
            `**Previous conversation:** ${prevConversation.length} exchanges`,
            prevConversation.length > 0
              ? prevConversation.slice(-6).map(c => `[${c.role}]: ${c.content.substring(0, 500)}${c.content.length > 500 ? "..." : ""}`).join("\n")
              : "",
            "",
            "You are continuing this agent's work. The workspace already contains research files, downloads, and other artifacts from previous work.",
            "Check the workspace before re-doing any research. Use `directory.list` or `directory.tree` on the workspace path to see what's already there.",
          ].filter(Boolean).join("\n");

          agent.addMessage({ role: "system", content: contextSummary });
        } else {
          // Normal path: create fresh workspace
          const { workspace: ws, setupCommands } = createWorkspace(agent.id);
          workspace = ws;
          agentWorkspaces.set(agent.id, ws);

          const WORKSPACE_SETUP_TIMEOUT_MS = 15_000;
          const setupPromises = setupCommands.map((cmd, cmdIdx) =>
            options.onExecuteCommand!({
              id: `ws_${agent.id}_${cmd.toolId}_${cmdIdx}`,
              type: "tool_execute",
              payload: { toolId: cmd.toolId, toolArgs: cmd.args },
              dryRun: false, timeout: 10000, sandboxed: false, requiresApproval: false,
            }).catch((err) => {
              log.warn("Workspace setup command failed", { agentId: agent.id, cmd: cmd.toolId, error: err });
              throw err;
            })
          );
          const abortCtrl = agentAbortControllers.get(agent.id);
          await Promise.race([
            Promise.all(setupPromises),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("Workspace setup timed out")), WORKSPACE_SETUP_TIMEOUT_MS)
            ),
            new Promise<never>((_, reject) => {
              if (abortCtrl?.signal.aborted) return reject(new Error("Agent aborted by supervisor"));
              abortCtrl?.signal.addEventListener("abort", () =>
                reject(new Error("Agent aborted by supervisor during workspace setup")), { once: true });
            }),
          ]);
        }

        // Save initial task.json
        taskJson = {
          taskId: agent.id,
          topic: agent.topic,
          createdAt: new Date().toISOString(),
          status: "running",
          lastActiveAt: new Date().toISOString(),
          persona: {
            systemPrompt: agent.systemPrompt,
            role: task.topic,
            temperature: 0.5,
            maxIterations: 50,
            modelTier: task.modelRole || "workhorse",
          },
          selectedToolIds: task.selectedToolIds,
          conversation: isContinuation
            ? [...(continuationContext.taskJson.conversation || [])]
            : [],
          progress: isContinuation
            ? { ...continuationContext.taskJson.progress, currentStep: "Continuing from previous work" }
            : { stepsCompleted: [], currentStep: "Starting" },
          originalMessageIndices: task.relevantMessageIndices || [],
          originalConversationSnapshot: conversationSnapshot,
          parentAgentId: isContinuation ? continuationContext.previousAgentId : undefined,
        };
        agentTaskJsonState.set(agent.id, taskJson);
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
      let result = await executeAgent(llm, options, request, agent, injectionQueue, abortController, workspace, agentJournals.get(agent.id), agentWaitResolvers);

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

      // Write execution journal to workspace (logs/execution.jsonl)
      const agentJournal = agentJournals.get(agent.id);
      if (workspace && options.onExecuteCommand && agentJournal?.length) {
        // Push lifecycle "completed" entry before writing
        agentJournal.push({
          ts: new Date().toISOString(), agentId: agent.id, type: "lifecycle",
          lifecycle: { event: "completed", detail: `response=${finalResponse.length} chars` },
        });
        for (const entry of agentJournal) {
          const logCmd = appendExecutionJournal(workspace, entry);
          options.onExecuteCommand({
            id: `ws_${agent.id}_journal_${entry.type}_${Date.now()}`,
            type: "tool_execute",
            payload: { toolId: logCmd.toolId, toolArgs: logCmd.args },
            dryRun: false, timeout: 5000, sandboxed: false, requiresApproval: false,
          }).catch((err) => {
            log.warn("Failed to write execution journal entry", { agentId: agent.id, type: entry.type, error: err });
          }); // fire-and-forget
        }
      }

      // Write conversation log to workspace (logs/conversation.json)
      if (workspace && options.onExecuteCommand && result.conversationLog?.length) {
        const convCmd = saveConversationLog(workspace, result.conversationLog);
        options.onExecuteCommand({
          id: `ws_${agent.id}_conversation`,
          type: "tool_execute",
          payload: { toolId: convCmd.toolId, toolArgs: convCmd.args },
          dryRun: false, timeout: 10000, sandboxed: false, requiresApproval: false,
        }).catch((err) => {
          log.warn("Failed to write conversation log", { agentId: agent.id, error: err });
        }); // fire-and-forget
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

      // Run reflector in background (non-blocking) — pass execution journal for self-reflection
      runReflectorAsync(llm, options, {
        originalPrompt: request.prompt,
        finalResponse,
        agentId: agent.topic,
        toolCallSummary: result.workLog,
        iterations: 0,
        executionTimeMs: Date.now() - startTime,
        judgeVerdict: judgeResult.verdict.verdict,
        executionJournal: agentJournal,
      });

    } catch (error) {
      const errMsg = error instanceof Error
        ? error.message
        : (typeof error === "object" && error !== null
          ? JSON.stringify(error)
          : String(error));
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

      // Write execution journal on failure
      const failJournal = agentJournals.get(agent.id);
      if (workspace && options.onExecuteCommand && failJournal?.length) {
        failJournal.push({
          ts: new Date().toISOString(), agentId: agent.id, type: "lifecycle",
          lifecycle: { event: "failed", detail: errMsg.substring(0, 500) },
        });
        for (const entry of failJournal) {
          const logCmd = appendExecutionJournal(workspace, entry);
          options.onExecuteCommand({
            id: `ws_${agent.id}_journal_${entry.type}_${Date.now()}`,
            type: "tool_execute",
            payload: { toolId: logCmd.toolId, toolArgs: logCmd.args },
            dryRun: false, timeout: 5000, sandboxed: false, requiresApproval: false,
          }).catch(() => {}); // fire-and-forget, already in error path
        }
      }

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

  // Merge responses and finalize the early result object
  earlyResult.success = agentResults.some(r => r.status === "completed");
  earlyResult.response = mergeAgentResponses(agentResults);
  // agentResults was populated by reference during execution via earlyResult.agentResults pushes above
  // but the local array was used — sync it back
  earlyResult.agentResults = agentResults;

  return earlyResult;
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
  abortController?: AbortController,
  workspace?: AgentWorkspace | null,
  journal?: ExecutionJournalEntry[],
  waitResolvers?: Map<string, (message: string) => void>
): Promise<{ response: string; workLog: string; escalated?: boolean; escalationReason?: string; neededToolCategories?: string[]; toolCallsMade?: { tool: string; args: Record<string, any>; result: string; success: boolean }[]; conversationLog?: Array<{ role: string; content: string; toolCalls?: any[] }> }> {
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

  // Execution journal — collects structured events for per-agent self-reflection
  // Uses the shared journal array (also receives supervisor events from parent scope)
  const agentJournal = journal || [];
  const journalPush = (entry: Omit<ExecutionJournalEntry, "ts" | "agentId">) => {
    agentJournal.push({ ts: new Date().toISOString(), agentId: agent.id, ...entry } as ExecutionJournalEntry);
  };

  // Track tool call start times for duration calculation
  const toolCallStartTimes = new Map<string, number>();

  // Wire synthetic tool callbacks in augmented options
  const augmentedOptions: AgentRunnerOptions & {
    onRequestTools?: (categories: string[]) => string[];
    onRequestResearch?: (query: string, depth: string, format: string) => Promise<string>;
  } = {
    ...options,

    // Tandem pipeline: persist large tool results to workspace research/ folder
    saveToWorkspace: workspace && options.onExecuteCommand
      ? (filename: string, content: string) => {
          const cmd = saveResearchOutput(workspace, filename, content);
          options.onExecuteCommand!({
            id: `ws_${agent.id}_research_${Date.now()}`,
            type: "tool_execute",
            payload: { toolId: cmd.toolId, toolArgs: cmd.args },
            dryRun: false, timeout: 10_000, sandboxed: false, requiresApproval: false,
          }).catch((err) => {
            log.warn("Failed to save research output to workspace", { agentId: agent.id, filename, error: err });
          });
        }
      : undefined,

    // Tandem pipeline: summarize large tool results via cheap/fast model (with journal)
    summarizeLargeResult: buildSummarizeCallback(agent.id, journalPush),

    // Execution journal: record model selection decisions
    onModelSelected: (info) => {
      journalPush({ type: "model_selected", model: info });
    },

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
      log.info("Agent requesting research", { agentId: agent.id, queryLength: query.length, depth, format });

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
        queryLength: query.length,
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

  const onWaitForUser = (reason: string, resumeHint?: string, timeoutMs?: number): Promise<string> => {
    log.info("Agent waiting for user input — blocking until user responds", {
      agentId: agent.id,
      reason,
      resumeHint,
      timeoutMs,
    });

    // Mark agent as blocked — the pipeline and tool loop pause here
    agent.block();

    return new Promise<string>((resolve, reject) => {
      // Default timeout: 60 minutes (onboarding can be slow)
      const effectiveTimeout = timeoutMs || 60 * 60 * 1000;
      const timer = setTimeout(() => {
        if (waitResolvers?.has(agent.id)) {
          waitResolvers.delete(agent.id);
          log.warn("Agent wait_for_user timed out", { agentId: agent.id, reason, timeoutMs: effectiveTimeout });
          reject(new Error(`Timed out waiting for user response (${Math.round(effectiveTimeout / 60_000)}m): ${reason}`));
        }
      }, effectiveTimeout);

      // Store the resolver — prompt-handler calls this when the user responds
      waitResolvers?.set(agent.id, (userMessage: string) => {
        clearTimeout(timer);
        waitResolvers.delete(agent.id);
        agent.start(); // Back to running
        log.info("Agent wait_for_user resolved by user message", { agentId: agent.id, messageLength: userMessage.length });
        resolve(userMessage);
      });

      // If no waitResolvers map available, fall back to immediate resolution (shouldn't happen)
      if (!waitResolvers) {
        clearTimeout(timer);
        log.warn("No waitResolvers map — falling back to immediate resolution", { agentId: agent.id });
        resolve(`[No wait mechanism available] User needs to: ${reason}`);
      }
    });
  };

  // Mark that the tool loop is about to start — supervisor uses this to avoid false-positive aborts
  agent.toolLoopStarted = true;

  // Wire agent activity tracking for the supervisor.
  // The tool loop fires onToolCall/onToolResult → execution.ts fires onTaskProgress.
  // The tool loop also fires onLLMResponse after each LLM call.
  // By intercepting both, we keep the supervisor informed of real progress
  // without coupling the tool loop to the SpawnedAgent class.
  // Lifecycle: agent started
  journalPush({ type: "lifecycle", lifecycle: { event: "started", detail: `topic="${agent.topic}", tools=${agent.selectedToolIds.length}` } });

  const originalOnTaskProgress = augmentedOptions.onTaskProgress;
  augmentedOptions.onTaskProgress = (update) => {
    if (update.eventType === "tool_call" || update.eventType === "tool_result") {
      agent.lastToolActivityAt = Date.now();
      if (update.eventType === "tool_call") {
        agent.toolCallCount++;
        // Record tool call start time for duration calculation
        if (update.tool) toolCallStartTimes.set(update.tool, Date.now());
      }
      if (update.eventType === "tool_result" && update.tool) {
        // Journal: tool call with actual duration
        const startTime = toolCallStartTimes.get(update.tool);
        const durationMs = startTime ? Date.now() - startTime : 0;
        toolCallStartTimes.delete(update.tool);
        journalPush({
          type: "tool_call",
          tool: {
            toolId: update.tool,
            durationMs,
            resultChars: update.resultLength || 0,
            success: update.success !== false,
          },
        });
      }
    }
    originalOnTaskProgress?.(update);
  };

  // Also update activity after each LLM response (covers slow model calls)
  const originalOnLLMResponse = augmentedOptions.onLLMResponse;
  augmentedOptions.onLLMResponse = (info) => {
    agent.lastToolActivityAt = Date.now();
    // Journal: LLM call with model, tokens, duration
    journalPush({
      type: "llm_call",
      llm: {
        provider: info.provider || "unknown",
        model: info.model || "unknown",
        inputTokens: info.inputTokens,
        outputTokens: info.outputTokens,
        durationMs: info.duration,
      },
    });
    originalOnLLMResponse?.(info);
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

// ============================================
// TANDEM RESEARCH PIPELINE
// ============================================

/** Max chars for the summarized extraction (the summary itself should be compact). */
const MAX_SUMMARY_CHARS = 3_000;

/**
 * Lazily-initialized cheap LLM client for inline summarization.
 * Created on first use so we don't pay startup cost if no large results appear.
 */
let summarizationClient: import("../llm/types.js").ILLMClient | null = null;

function getSummarizationClient(): import("../llm/types.js").ILLMClient | null {
  if (summarizationClient) return summarizationClient;

  // Try xAI Grok first (fast, 131K context, cheap at $0.001/1K input), then DeepSeek, then OpenAI
  for (const provider of ["xai", "deepseek", "openai", "gemini"] as const) {
    const apiKey = getApiKeyForProvider(provider);
    if (apiKey) {
      try {
        summarizationClient = createLLMClient({ provider, apiKey });
        log.info("Summarization client initialized", { provider });
        return summarizationClient;
      } catch (err) {
        log.warn("Failed to create summarization client", { provider, error: err });
      }
    }
  }

  log.warn("No API key available for inline summarization — will fall back to truncation");
  return null;
}

/**
 * Build a summarizeLargeResult callback for an agent.
 * Uses a cheap/fast model to extract key facts from large tool results
 * so expensive models don't have to process raw data.
 */
function buildSummarizeCallback(
  agentId: string,
  journalPush?: (entry: Omit<ExecutionJournalEntry, "ts" | "agentId">) => void,
) {
  return async (toolId: string, rawResult: string): Promise<string> => {
    const client = getSummarizationClient();
    if (!client) throw new Error("No summarization client available");

    const startTime = Date.now();
    log.info("Summarizing large tool result via cheap model", {
      agentId, toolId, rawChars: rawResult.length,
    });

    const response = await client.chat(
      [
        {
          role: "system",
          content: "You are a data extraction assistant. Extract the key facts, data points, and relevant information from the tool result below. Be concise — use bullet points. Preserve exact numbers, names, URLs, and quotes. Output ONLY the extracted information, no commentary or preamble.",
        },
        {
          role: "user",
          content: `Tool: ${toolId}\n\nResult:\n${rawResult}`,
        },
      ],
      { maxTokens: 1024 },
    );

    const summary = (response.content || "").substring(0, MAX_SUMMARY_CHARS);
    const durationMs = Date.now() - startTime;
    log.info("Summarization complete", {
      agentId, toolId,
      originalChars: rawResult.length,
      summaryChars: summary.length,
      durationMs,
      provider: response.provider,
      model: response.model,
    });

    // Journal: summarization event
    journalPush?.({
      type: "summarization",
      summarization: {
        toolId,
        originalChars: rawResult.length,
        summaryChars: summary.length,
        provider: response.provider || "unknown",
        durationMs,
      },
    });

    return summary;
  };
}
