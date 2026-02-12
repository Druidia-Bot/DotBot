/**
 * Agent Pipeline - V2 Only
 *
 * The V2 execution pipeline: short path → receptionist → persona writer → spawned agents
 * All V1 code removed. Uses workspaces instead of threads.
 */

import { nanoid } from "nanoid";
import { getPersona } from "../personas/loader.js";
import type { ILLMClient } from "../llm/providers.js";
import { createComponentLogger } from "../logging.js";
import type {
  EnhancedPromptRequest,
  ReceptionistDecision,
  PersonaDefinition,
} from "../types/agent.js";
import type { AgentRunnerOptions, AgentRunResult } from "./runner-types.js";
import { runReceptionist, runJudge, runUpdaterAsync } from "./intake.js";

// V2: Re-export all V2 modules for consumers
export { executeWithSpawnedAgents } from "./orchestrator.js";
export type { AgentTask, OrchestratorResult } from "./orchestrator.js";
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

// V2: Core tool registry + platform filters
export { CORE_TOOLS, getCoreToolById, getCoreToolsByCategory, getCoreCategories } from "../tools/core-registry.js";
export type { CoreToolDefinition } from "../tools/core-registry.js";
export { filterCoreTools, filterManifest, mergeWithCoreRegistry, getToolExecutor } from "../tools/platform-filters.js";

// V2 imports for the V2 pipeline path
import { tryShortPath } from "./short-path.js";
import { writePersonas } from "./persona-writer.js";
import { executeWithSpawnedAgents } from "./orchestrator.js";
import { MessageRouter } from "./message-router.js";

const log = createComponentLogger("pipeline");

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
 * Removed from V1: RunJournal, thread persistence, executeFullPipeline
 */
export async function executeV2Pipeline(
  llm: ILLMClient,
  options: AgentRunnerOptions,
  request: EnhancedPromptRequest,
  userId: string,
  sessionId: string,
  router?: MessageRouter,
  precomputedDecision?: ReceptionistDecision,
): Promise<AgentRunResult & { router?: MessageRouter; agentResults?: Array<{ agentId: string; topic: string; response: string; status: string }>; decision?: ReceptionistDecision }> {
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
  const activeAgentSummary = messageRouter.getActiveAgentSummary();
  const existingAgents = messageRouter.getAgents();

  if (existingAgents.length > 0) {
    // Check all agents (including completed) for topic continuity
    const matchedAgent = messageRouter.findBestAgentForMessage(request.prompt, false);
    if (matchedAgent) {
      log.info("V2 pipeline: follow-up routing matched existing agent", {
        agentId: matchedAgent.id,
        topic: matchedAgent.topic,
        status: matchedAgent.status,
      });

      // Create a continuation task reusing the previous agent's config
      const continuationTask: import("./orchestrator.js").AgentTask = {
        task: request.prompt,
        topic: matchedAgent.topic,
        systemPrompt: matchedAgent.systemPrompt,
        selectedToolIds: matchedAgent.selectedToolIds,
        modelRole: matchedAgent.modelRole,
      };

      // If the matched agent had a response, include it as conversation context
      // so the new agent has continuity with the previous exchange
      if (matchedAgent.response) {
        continuationTask.systemPrompt += `\n\n## Previous Exchange on This Topic\nYou previously handled this topic and responded:\n\n${matchedAgent.response.substring(0, 2000)}\n\nThe user is now following up on this topic.`;
      }

      log.info("V2 pipeline: executing follow-up with spawned agent");
      const result = await executeWithSpawnedAgents(
        llm, options, request, [continuationTask], messageRouter
      );

      // Fire-and-forget memory update
      runUpdaterAsync(llm, options, request, result.response, [], {
        classification: "CONTINUATION",
        priority: "BLOCKING",
        confidence: 0.9,
        threadIds: [],
        createNewThread: false,
        personaId: undefined,
        councilNeeded: false,
        reasoning: `Follow-up to agent ${matchedAgent.id} (${matchedAgent.topic})`,
        memoryAction: "session_only",
      }, userId);

      log.info("V2 pipeline: follow-up complete", {
        success: result.success,
        matchedAgent: matchedAgent.id,
      });

      return {
        success: result.success,
        response: result.response,
        classification: "CONTINUATION",
        threadIds: [],
        keyPoints: [],
        router: messageRouter,
        agentResults: result.agentResults,
      };
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
  log.info("V2 pipeline: writing personas");
  const tasks = await writePersonas(llm, options, request, decision);
  log.info("V2 pipeline: personas written", {
    taskCount: tasks.length,
    topics: tasks.map(t => t.topic),
  });

  // Step 5: Orchestrator spawns and executes agents (with persistent router)
  log.info("V2 pipeline: executing with spawned agents");
  const result = await executeWithSpawnedAgents(llm, options, request, tasks, messageRouter);

  // Fire-and-forget memory update
  runUpdaterAsync(llm, options, request, result.response, [], decision, userId);

  log.info("V2 pipeline: complete", {
    success: result.success,
    agentCount: result.agentResults.length,
  });

  return {
    success: result.success,
    response: result.response,
    classification: decision.classification,
    threadIds: [],
    keyPoints: [],
    router: messageRouter,
    agentResults: result.agentResults,
    decision,
  };
}
