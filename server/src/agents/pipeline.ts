/**
 * Agent Pipeline
 *
 * Linear execution flow:
 *   short path → follow-up routing → receptionist → persona writer → orchestrator → council (if needed)
 */

import { resolveCouncil } from "../personas/council-loader.js";
import type { ILLMClient } from "../llm/providers.js";
import { createComponentLogger } from "../logging.js";
import type {
  EnhancedPromptRequest,
  ReceptionistDecision,
} from "../types/agent.js";
import type { AgentRunnerOptions, AgentRunResult } from "./runner-types.js";
import { runReceptionist, runJudge, runUpdaterAsync } from "./intake.js";
import { runCouncilDiscussion } from "./council-orchestrator.js";

// V2: Re-export all V2 modules for consumers
export { executeWithSpawnedAgents } from "./orchestrator.js";
export type { AgentTask, OrchestratorResult, ContinuationContext } from "./orchestrator.js";
export { SpawnedAgent } from "./spawned-agent.js";
export { MessageRouter } from "./message-router.js";
export { writePersonas } from "./persona-writer.js";
export { tryShortPath } from "./short-path.js";
export type { ShortPathResult } from "./short-path.js";
export { AgentSupervisor } from "./supervisor.js";
export type { AgentStatusReport } from "./supervisor.js";
export { runEnhancedJudge } from "./judge.js";
export type { EnhancedJudgeVerdict, JudgeContext } from "./judge.js";
export { createResearchTask, parseResearchRequest } from "./research-protocol.js";
export type { ResearchRequest, ResearchDepth } from "./research-protocol.js";
export {
  createWorkspace, cleanupWorkspace, getWorkspacePath,
  saveTaskJson, updateTaskJson, completeTask,
  appendToolCallLog,
  saveOutputFile, saveResearchOutput,
  listWorkspaceFolders, readTaskJson, categorizeIncompleteTasks,
} from "./workspace.js";
export type { AgentWorkspace, WorkspaceCommand, TaskJson, ToolCallLogEntry } from "./workspace.js";
export { runReflectorAsync } from "./reflector.js";
export type { ReflectorOutput } from "./reflector.js";
export { handleEscalation } from "./architect.js";
export type { EscalationContext, ArchitectDecision } from "./architect.js";
export { recordTokenUsage, getDeviceUsage, getAgentUsage } from "./token-tracker.js";
export type { TokenUsageEntry } from "./token-tracker.js";

// V2: Councils
export { runCouncilDiscussion } from "./council-orchestrator.js";
export type { CouncilTurn, CouncilResult } from "./council-orchestrator.js";

// V2: Core tool registry + platform filters
export { CORE_TOOLS, getCoreToolById, getCoreToolsByCategory, getCoreCategories } from "../tools/core-registry.js";
export type { CoreToolDefinition } from "../tools/core-registry.js";
export { filterCoreTools, filterManifest, mergeWithCoreRegistry, getToolExecutor } from "../tools/platform-filters.js";

// V2 imports for the V2 pipeline path
import { tryShortPath } from "./short-path.js";
import { writePersonas } from "./persona-writer.js";
import { executeWithSpawnedAgents } from "./orchestrator.js";
import { MessageRouter } from "./message-router.js";
import {
  isTaskStale,
  failStaleTask,
  completeTask,
  scheduleWorkspaceCleanup,
} from "./workspace.js";
import type { OrchestratorResult } from "./orchestrator.js";

const log = createComponentLogger("pipeline");

/**
 * Check for stale blocked tasks and auto-fail them.
 * Stale = blocked for > 7 days with no activity.
 *
 * When a blocked task is stale:
 * 1. Mark as failed in task.json with failure reason
 * 2. Delete task.json to mark as complete
 * 3. Schedule workspace cleanup (24 hours after deletion)
 */
function checkAndCleanupStaleTasks(
  orchestratorResult: OrchestratorResult,
  options: AgentRunnerOptions
): void {
  const { taskJsonState, workspaces } = orchestratorResult;

  for (const [agentId, taskJson] of taskJsonState.entries()) {
    if (isTaskStale(taskJson)) {
      const workspace = workspaces.get(agentId);
      if (!workspace) {
        log.warn("Stale task found but no workspace - skipping", { agentId });
        continue;
      }

      log.info("Auto-failing stale blocked task", {
        agentId,
        topic: taskJson.topic,
        lastActiveAt: taskJson.lastActiveAt,
        inactiveDays: Math.round(
          (Date.now() - new Date(taskJson.lastActiveAt).getTime()) / (24 * 60 * 60 * 1000)
        ),
      });

      // 1. Update task.json with failure status
      const failCmd = failStaleTask(workspace, taskJson);
      options.onExecuteCommand?.({
        id: `ws_${agentId}_fail_stale`,
        type: "tool_execute",
        payload: { toolId: failCmd.toolId, toolArgs: failCmd.args },
        dryRun: false,
        timeout: 10000,
        sandboxed: false,
        requiresApproval: false,
      });

      // 2. Delete task.json to mark as complete
      const completeCmd = completeTask(workspace);
      options.onExecuteCommand?.({
        id: `ws_${agentId}_complete_stale`,
        type: "tool_execute",
        payload: { toolId: completeCmd.toolId, toolArgs: completeCmd.args },
        dryRun: false,
        timeout: 10000,
        sandboxed: false,
        requiresApproval: false,
      });

      // 3. Schedule workspace cleanup (24 hours from now)
      scheduleWorkspaceCleanup(agentId);

      // Remove from in-memory state
      taskJsonState.delete(agentId);
    }
  }
}

/**
 * V2 Pipeline Entry Point
 *
 * Flow:
 * 1. Short path check (greetings, acks)
 * 2. Follow-up routing check (conversation isolation)
 * 3. Receptionist classification
 * 4. Persona writer creates agent tasks
 * 5. Orchestrator spawns and executes agents
 *
 * Removed: RunJournal, thread persistence, executeFullPipeline, fast paths
 */
export async function executeV2Pipeline(
  llm: ILLMClient,
  options: AgentRunnerOptions,
  request: EnhancedPromptRequest,
  userId: string,
  sessionId: string,
  router?: MessageRouter,
  precomputedDecision?: ReceptionistDecision,
  previousOrchestratorResult?: import("./orchestrator.js").OrchestratorResult,
  onOrchestratorReady?: (result: import("./orchestrator.js").OrchestratorResult) => void,
): Promise<AgentRunResult & { router?: MessageRouter; agentResults?: Array<{ agentId: string; topic: string; response: string; status: string }>; decision?: ReceptionistDecision; orchestratorResult?: import("./orchestrator.js").OrchestratorResult }> {
  // Reuse or create a message router for session continuity
  const messageRouter = router || new MessageRouter();

  // Step 1: Short path — skip everything for greetings, acks, farewells
  // Pass active agent count so short path can skip ambiguous messages that might be follow-ups
  const existingAgentCount = messageRouter.getAgents().length;
  log.info("V2 pipeline: checking short path", { existingAgentCount });

  const shortResult = await tryShortPath(llm, options, request, existingAgentCount);
  if (shortResult.isShortPath && shortResult.response) {
    log.info("V2 pipeline: short path hit", { reason: shortResult.reason });

    // Fire-and-forget memory update
    runUpdaterAsync(llm, options, request, shortResult.response, [], {
      classification: "CONVERSATIONAL",
      priority: "BLOCKING",
      confidence: 1.0,
      threadIds: [],
      createNewThread: false,
      personaId: undefined,
      councilNeeded: false,
      reasoning: `Short path: ${shortResult.reason}`,
      memoryAction: "session_only",
    }, userId);

    return {
      success: true,
      response: shortResult.response,
      classification: "CONVERSATIONAL",
      threadIds: [],
      keyPoints: [],
      router: messageRouter,
    };
  }

  // Step 2: Check if this message is a follow-up to an existing agent's topic
  // This enables conversation isolation — follow-ups route to the right agent
  let continuationCtx: import("./orchestrator.js").ContinuationContext | undefined;
  const activeAgentSummary = messageRouter.getActiveAgentSummary();
  const existingAgents = messageRouter.getAgents();

  if (existingAgents.length > 0) {
    // Check all agents (including completed) for topic continuity
    // Skip failed agents — their task is dead, route through fresh classification instead
    const matchedAgent = messageRouter.findBestAgentForMessage(request.prompt, false);
    if (matchedAgent && matchedAgent.status !== "failed") {
      log.info("V2 pipeline: follow-up routing matched existing agent", {
        agentId: matchedAgent.id,
        topic: matchedAgent.topic,
        status: matchedAgent.status,
      });

      // V2 INJECTION: If agent is running or blocked (paused), inject message instead of spawning continuation
      if ((matchedAgent.status === "running" || matchedAgent.status === "blocked") && previousOrchestratorResult) {
        const injectionQueue = previousOrchestratorResult.injectionQueues.get(matchedAgent.id);
        const workspace = previousOrchestratorResult.workspaces.get(matchedAgent.id);
        const taskJson = previousOrchestratorResult.taskJsonState.get(matchedAgent.id);

        if (injectionQueue && workspace && taskJson) {
          log.info("V2 pipeline: injecting message into agent", {
            agentId: matchedAgent.id,
            topic: matchedAgent.topic,
            status: matchedAgent.status,
            queueLength: injectionQueue.length,
          });

          // 1. Push to injection queue (tool loop will pick it up)
          injectionQueue.push(request.prompt);

          // 2. Add to agent's conversation
          matchedAgent.addUserMessage(request.prompt);

          // 3. Update task.json with new conversation entry in real-time
          if (options.onExecuteCommand) {
            const { appendConversationEntry } = await import("./workspace.js");
            const updateCmd = appendConversationEntry(workspace, taskJson, {
              role: "user",
              content: request.prompt,
              timestamp: new Date().toISOString(),
            });
            options.onExecuteCommand({
              id: `ws_${matchedAgent.id}_inject_${Date.now()}`,
              type: "tool_execute",
              payload: { toolId: updateCmd.toolId, toolArgs: updateCmd.args },
              dryRun: false,
              timeout: 5000,
              sandboxed: false,
              requiresApproval: false,
            }).catch((err) => {
              log.warn("Failed to update task.json with injection", { agentId: matchedAgent.id, error: err });
            });
          }

          const statusMessage = matchedAgent.status === "blocked"
            ? "🔄 Message delivered to paused agent. Resuming..."
            : "📨 Message delivered to running agent. The agent will respond shortly.";

          return {
            success: true,
            response: statusMessage,
            classification: "CONVERSATIONAL", // Message injection into running agent (not a new task classification)
            threadIds: [],
            keyPoints: [],
            router: messageRouter,
            orchestratorResult: previousOrchestratorResult,
          };
        } else {
          log.warn("V2 pipeline: agent is active but injection infrastructure not found", {
            agentId: matchedAgent.id,
            status: matchedAgent.status,
            hasQueue: !!injectionQueue,
            hasWorkspace: !!workspace,
            hasTaskJson: !!taskJson,
          });
        }
      }

      // Agent completed/not running — capture continuation context so the new agent
      // reuses the same workspace (research files, downloads, artifacts are still there).
      if (previousOrchestratorResult) {
        const prevWorkspace = previousOrchestratorResult.workspaces.get(matchedAgent.id);
        const prevTaskJson = previousOrchestratorResult.taskJsonState.get(matchedAgent.id);
        if (prevWorkspace && prevTaskJson) {
          continuationCtx = {
            workspace: prevWorkspace,
            taskJson: prevTaskJson,
            previousResponse: matchedAgent.response || "",
            previousAgentId: matchedAgent.id,
          };
          log.info("V2 pipeline: captured continuation context for workspace reuse", {
            agentId: matchedAgent.id,
            workspacePath: prevWorkspace.basePath,
          });
        }
      }

      // Enrich context with previous response so the receptionist + persona writer
      // understand this is a follow-up
      if (matchedAgent.response) {
        request.recentHistory = [
          ...request.recentHistory,
          { role: "assistant" as const, content: matchedAgent.response.substring(0, 2000) },
        ];
      }
      log.info("V2 pipeline: matched agent completed, falling through to receptionist with continuation context", {
        agentId: matchedAgent.id,
        status: matchedAgent.status,
        hasContinuation: !!continuationCtx,
      });
    }
  }

  // Step 3: Receptionist classifies (or use precomputed decision if provided)
  let decision: ReceptionistDecision;
  if (precomputedDecision) {
    log.info("V2 pipeline: using precomputed receptionist decision");
    decision = precomputedDecision;
  } else {
    log.info("V2 pipeline: running receptionist");
    decision = await runReceptionist(llm, options, request, userId);
  }
  log.info("V2 pipeline: receptionist decision", {
    classification: decision.classification,
    confidence: decision.confidence,
    persona: decision.personaId,
    activeAgents: activeAgentSummary ? activeAgentSummary.split("\n").length : 0,
  });

  // Direct responses from receptionist (CONVERSATIONAL etc.)
  const needsExecution = ["ACTION", "INFO_REQUEST", "CONTINUATION", "CORRECTION", "COMPOUND"].includes(decision.classification);
  if (decision.directResponse && !needsExecution) {
    log.info("V2 pipeline: using receptionist direct response");

    // Fire-and-forget memory update
    runUpdaterAsync(llm, options, request, decision.directResponse, [], decision, userId);

    return {
      success: true,
      response: decision.directResponse,
      classification: decision.classification,
      threadIds: [],
      keyPoints: [],
      router: messageRouter,
      decision,
    };
  }

  // Step 4: Persona writer creates dynamic agent tasks
  // Local personas (decision.localPersonaSlug) are handled by the persona writer —
  // it incorporates the persona's identity/voice into the task-specific prompt.
  log.info("V2 pipeline: writing personas");
  const { tasks, conversationSnapshot } = await writePersonas(llm, options, request, decision);
  log.info("V2 pipeline: personas written", {
    taskCount: tasks.length,
    topics: tasks.map(t => t.topic),
  });

  // Step 5: Orchestrator spawns and executes agents (with persistent router)
  log.info("V2 pipeline: executing with spawned agents");
  const result = await executeWithSpawnedAgents(llm, options, request, tasks, messageRouter, conversationSnapshot, onOrchestratorReady, continuationCtx);

  // Check for stale blocked tasks and auto-fail them
  checkAndCleanupStaleTasks(result, options);

  // Step 6: Council review (optional) — runs AFTER agents complete their work
  let finalResponse = result.response;
  if (decision.councilNeeded && decision.councilId) {
    try {
      const council = resolveCouncil(decision.councilId);
      log.info("V2 pipeline: running council discussion on agent output", {
        councilId: decision.councilId,
        councilName: council.name,
        participants: council.personas.map((p) => p.name),
        rounds: council.protocol.rounds,
      });

      const councilResult = await runCouncilDiscussion(
        llm,
        options,
        council,
        request.prompt,
        result.response,
        options.onCouncilStream
      );

      finalResponse = councilResult.finalResponse;
      log.info("V2 pipeline: council review complete", {
        rounds: councilResult.rounds,
        consensusReached: councilResult.consensusReached,
      });
    } catch (err) {
      log.error("V2 pipeline: council review failed, using agent output as-is", { error: err });
    }
  }

  // Fire-and-forget memory update
  runUpdaterAsync(llm, options, request, finalResponse, [], decision, userId);

  log.info("V2 pipeline: complete", {
    success: result.success,
    agentCount: result.agentResults.length,
    hadCouncilReview: !!(decision.councilNeeded && decision.councilId),
  });

  return {
    success: result.success,
    response: finalResponse,
    classification: decision.classification,
    threadIds: [],
    keyPoints: [],
    router: messageRouter,
    agentResults: result.agentResults,
    decision,
    orchestratorResult: result,
  };
}
