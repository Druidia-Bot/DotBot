/**
 * Receptionist — Orchestrator
 *
 * Gathers all context an agent needs before execution begins.
 * Delegates to focused modules for each concern:
 *
 *   agent-exec.ts         — tool execution + workspace file ops
 *   memory-fetch.ts       — conversation/model fetching
 *   tools.ts              — receptionist tool loop (LLM-driven)
 *   search-files.ts       — local file search (Windows/Everything)
 *   search-web.ts         — web search (Brave) + markdown builder
 *   search-polymarket.ts  — prediction market search (Polymarket)
 *   output.ts             — knowledgebase builders
 *   types.ts              — shared interfaces
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "../logging.js";
import { createWorkspace } from "../agents/workspace.js";
import { getDeviceForUser } from "../ws/devices.js";
import type { ILLMClient } from "../llm/types.js";
import type { EnhancedPromptRequest } from "../types/agent.js";
import type { ClassifyResult } from "../intake/intake.js";

import type { ReceptionistResult } from "./types.js";
export type { ReceptionistResult } from "./types.js";

import {
  execToolOnAgent,
  writeWorkspaceFile,
  writeAgentAssignments,
} from "./agent-exec.js";
import { runReceptionistLoop } from "./tools.js";
import { fetchMemoryContext } from "./memory-fetch.js";
import { buildIntakeKnowledge } from "./output.js";
import { searchLocalFiles } from "./search-files.js";
import { searchWebForContext } from "./search-web.js";
import { searchPolymarket } from "./search-polymarket.js";

const log = createComponentLogger("receptionist");

// ============================================
// FIFO QUEUE — only one receptionist at a time
// ============================================

let receptionistQueue: Promise<any> = Promise.resolve();

/**
 * Queue a receptionist run. Requests are processed FIFO — each waits
 * for the previous to finish before starting. Multiple spawned agents
 * can run concurrently after handoff, but there is only one receptionist.
 */
export function runReceptionist(
  llm: ILLMClient,
  userId: string,
  request: EnhancedPromptRequest,
  intakeResult: ClassifyResult
): Promise<ReceptionistResult> {
  const task = receptionistQueue.then(() =>
    _runReceptionist(llm, userId, request, intakeResult)
  );
  // Swallow errors in the chain so a failed run doesn't block future runs
  receptionistQueue = task.catch(() => {});
  return task;
}

// ============================================
// MAIN ENTRY (internal — called via queue)
// ============================================

async function _runReceptionist(
  llm: ILLMClient,
  userId: string,
  request: EnhancedPromptRequest,
  intakeResult: ClassifyResult
): Promise<ReceptionistResult> {
  const agentId = `agent_${nanoid(12)}`;

  const deviceId = getDeviceForUser(userId);
  if (!deviceId) {
    throw new Error("No local agent connected — cannot create workspace");
  }

  // ── Step 1: Fetch memory context ──
  const {
    conversationHistory,
    relevantModelSummaries,
    relatedConversationsText,
  } = await fetchMemoryContext(deviceId, intakeResult, request);
  log.info("Memory context loaded", {
    messageCount: conversationHistory.length,
  });

  // ── Step 2: Run tool loop + all searches in parallel ──
  const [loopResult, localFileSearch, webSearchResults, polymarketResults] =
    await Promise.all([
      runReceptionistLoop(
        llm,
        request,
        intakeResult,
        conversationHistory,
        relevantModelSummaries,
        relatedConversationsText,
        deviceId
      ),
      searchLocalFiles(userId, deviceId, agentId, request, intakeResult),
      searchWebForContext(deviceId, agentId, request, intakeResult),
      searchPolymarket(llm, deviceId, agentId, request, intakeResult),
    ]);

  const localFileResults = localFileSearch.results;

  const {
    resurfacedModels,
    newModelsCreated,
    savedToModels,
    knowledgeGathered,
    knowledgeSearchCount,
  } = loopResult;
  if (localFileResults.length > 0)
    log.info("Local file search complete", {
      searches: localFileResults.length,
    });
  else if (localFileSearch.skipReason)
    log.info("Local file search skipped", { reason: localFileSearch.skipReason });
  if (webSearchResults.length > 0)
    log.info("Web search complete", { queries: webSearchResults.length });
  if (polymarketResults.length > 0)
    log.info("Polymarket search complete", {
      queries: polymarketResults.length,
    });

  // ── Step 3: Create agent workspace ──
  const { workspace, setupCommands } = createWorkspace(agentId);
  for (const cmd of setupCommands) {
    try {
      await execToolOnAgent(deviceId, agentId, cmd.toolId, cmd.args);
    } catch (err) {
      log.warn("Workspace setup command failed", {
        agentId,
        tool: cmd.toolId,
        error: err,
      });
    }
  }
  log.info("Agent workspace created", { agentId, path: workspace.basePath });

  // ── Step 4: Write agent assignments to affected models ──
  await writeAgentAssignments(
    deviceId,
    agentId,
    workspace.basePath,
    request.prompt,
    savedToModels,
    newModelsCreated
  );

  // ── Step 5: Save intake_knowledge.md ──
  const knowledgebase = await buildIntakeKnowledge({
    agentId,
    request,
    intakeResult,
    relevantModelSummaries,
    knowledgeResults: knowledgeGathered,
    knowledgeSearchCount,
    resurfacedModels,
    newModelsCreated,
    localFileResults,
    localFileSearchSkipReason: localFileSearch.skipReason,
    webSearchResults,
    polymarketResults,
  });
  const knowledgebasePath = `${workspace.basePath}/intake_knowledge.md`;
  await writeWorkspaceFile(deviceId, agentId, knowledgebasePath, knowledgebase);

  log.info("Receptionist complete", {
    agentId,
    workspace: workspace.basePath,
    resurfacedModels: resurfacedModels.length,
    newModelsCreated: newModelsCreated.length,
    knowledgeGathered: knowledgeGathered.length,
  });

  return {
    agentId,
    workspacePath: workspace.basePath,
    knowledgebasePath,
    resurfacedModels,
    newModelsCreated,
    knowledgeGathered: knowledgeGathered.length,
    intakeKnowledgebase: knowledgebase,
  };
}
