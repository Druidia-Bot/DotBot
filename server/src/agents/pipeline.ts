/**
 * Agent Pipeline
 * 
 * The full execution pipeline: receptionist → persona → tools → council → judge.
 * Extracted from AgentRunner to separate orchestration concerns from
 * pipeline execution logic.
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
import { executeWithPersona, generateSimpleResponse } from "./execution.js";
import {
  createTrackedTask,
  completeTrackedTask,
  resumeTrackedTask,
  persistToThread,
} from "./task-tracking.js";
import { blockTask } from "./agent-tasks.js";
import type { RunJournal } from "./self-recovery.js";
import { executeComplexPath } from "./pipeline-complex.js";

const log = createComponentLogger("pipeline");

/** Create an onWaitForUser callback bound to a specific task, or undefined if no taskId. */
function makeWaitCallback(taskId: string | undefined) {
  return taskId
    ? (reason: string, resumeHint?: string, timeoutMs?: number) => blockTask(taskId, reason, resumeHint, timeoutMs)
    : undefined;
}

// ============================================
// FULL PIPELINE
// ============================================

/**
 * The full agent pipeline: receptionist → persona → tools → council → judge.
 * 
 * Can accept a pre-computed receptionist decision (from the orchestrator's
 * classify() call) to avoid running the receptionist twice.
 */
export async function executeFullPipeline(
  llm: ILLMClient,
  options: AgentRunnerOptions,
  request: EnhancedPromptRequest,
  userId: string,
  sessionId: string,
  journal: RunJournal,
  setTaskId: (id: string | undefined) => void,
  precomputedDecision?: ReceptionistDecision,
  injectionQueue?: string[],
  getAbortSignal?: () => AbortSignal | undefined
): Promise<AgentRunResult> {
  // Phase 1: Receptionist decides what to do (skip if pre-computed)
  let decision: ReceptionistDecision;
  if (precomputedDecision) {
    decision = precomputedDecision;
    journal.log("receptionist", "Using pre-computed decision", {
      classification: decision.classification,
      persona: decision.personaId,
    });
  } else {
    journal.log("receptionist", "Classifying request");
    decision = await runReceptionist(llm, options, request, userId);
  }

  journal.log("receptionist", "Decision made", {
    classification: decision.classification,
    persona: decision.personaId,
    confidence: decision.confidence,
    directResponse: !!decision.directResponse,
  });

  log.info("Receptionist decision", {
    classification: decision.classification,
    confidence: decision.confidence,
    councilNeeded: decision.councilNeeded,
  });

  // Resolve thread ID
  const threadId = resolveThreadId(request);
  const threadIds = [threadId];

  // Handle direct responses (CONVERSATIONAL, MEMORY_UPDATE, etc.)
  // Only short-circuit for classifications that genuinely don't need tool execution.
  // The receptionist sometimes sets directResponse even for actionable classifications
  // (e.g., CORRECTION with personaId) — in those cases we must proceed to execution.
  const needsExecution = ["ACTION", "INFO_REQUEST", "CONTINUATION", "CORRECTION", "COMPOUND"].includes(decision.classification);
  if (decision.directResponse && !needsExecution) {
    journal.log("response", "Using receptionist direct response");
    persistToThread(options, threadId, decision.newThreadTopic || request.prompt.substring(0, 80), request.prompt, decision.directResponse);
    runUpdaterAsync(llm, options, request, decision.directResponse, [], decision, userId);
    return {
      success: true,
      response: decision.directResponse,
      classification: decision.classification,
      threadIds,
      keyPoints: [],
    };
  }

  // Resolve target persona early — this determines our execution path
  // Allow personaHint (e.g., from scheduled tasks) to override the receptionist's pick
  let targetPersonaId = decision.personaId || decision.councilId;
  if (request.hints?.personaHint) {
    const hintedPersona = getPersona(request.hints.personaHint);
    if (hintedPersona) {
      journal.log("pipeline", `personaHint override: ${request.hints.personaHint} (was ${targetPersonaId || "none"})`);
      targetPersonaId = request.hints.personaHint;
    }
  }
  const targetPersona = targetPersonaId ? getPersona(targetPersonaId) : null;
  
  if (targetPersonaId && !targetPersona) {
    journal.logError("persona", `Invalid personaId: ${targetPersonaId}`);
    log.warn(`Invalid personaId: ${targetPersonaId}, falling back`);
  }

  // Determine if this is an actionable request
  const isActionable = ["ACTION", "INFO_REQUEST", "CONTINUATION", "CORRECTION", "COMPOUND"].includes(decision.classification);

  // For CONTINUATION with a resumeTaskId, reuse the existing task; otherwise create a new one
  let taskId: string | undefined;
  if (decision.resumeTaskId && isActionable) {
    taskId = decision.resumeTaskId;
    resumeTrackedTask(options, taskId);
    log.info("Resuming tracked task", { taskId });
  } else if (isActionable) {
    taskId = await createTrackedTask(options, decision, threadId, request.prompt);
  }
  setTaskId(taskId);

  if (isActionable) {
    // Multi-item detection: two layers of defense against misclassified multi-item messages.
    // 1. Local LLM hint (trusted — Qwen 0.5B ran on-device before the message reached us)
    // 2. Regex heuristic (fallback — when local LLM is unavailable or didn't run)
    if (decision.classification !== "COMPOUND") {
      const localLLMSaysMulti = request.hints?.multiItem === true;
      const regexSaysMulti = looksLikeMultipleItems(request.prompt);

      if (localLLMSaysMulti || regexSaysMulti) {
        const source = localLLMSaysMulti ? "local LLM" : "regex heuristic";
        journal.log("pipeline", `COMPOUND override (${source}) — message looks like multiple items`, {
          originalClassification: decision.classification,
          originalConfidence: decision.confidence,
          source,
        });
        log.info("Heuristic COMPOUND override", {
          originalClassification: decision.classification,
          originalConfidence: decision.confidence,
          persona: decision.personaId,
          source,
        });
        decision.classification = "COMPOUND";
        decision.confidence = 0.5; // Force planner path
      }
    }

    // Fast path: skip planner + judge when we have a clear single-persona task.
    // Like Cascade — get the message, pick the persona, start working. No committee.
    // Planner is only needed for COMPOUND tasks or uncertain routing.
    const canFastPath = targetPersona
      && (decision.confidence || 0) >= 0.8
      && decision.classification !== "COMPOUND"
      && !decision.councilNeeded
      && !decision.reviewCouncilSlug;

    if (canFastPath) {
      journal.log("pipeline", "Fast path — skipping planner (high-confidence single persona)", {
        persona: targetPersona!.id,
        confidence: decision.confidence,
      });
      log.info("Fast path — direct execution", {
        persona: targetPersona!.id,
        confidence: decision.confidence,
        classification: decision.classification,
      });
      return executeFastPath(
        llm, options, request, decision, targetPersona!,
        threadId, threadIds, taskId, journal, userId,
        injectionQueue, getAbortSignal
      );
    }

    // Full path: planner decomposes task, assigns personas, handles multi-step work
    journal.log("pipeline", "Full path — routing to planner for task decomposition", {
      reason: !targetPersona ? "no persona" : decision.classification === "COMPOUND" ? "compound task" : `low confidence (${decision.confidence})`,
    });
    return executeComplexPath(
      llm, options, request, decision,
      threadId, threadIds, taskId, journal, userId, sessionId,
      injectionQueue, getAbortSignal
    );
  }

  // For non-actionable requests without a council, use simple response
  if (!decision.councilNeeded) {
    return executeSimplePath(
      llm, options, request, decision,
      threadId, threadIds, taskId, journal, userId
    );
  }

  // Council-needed path (rare — non-actionable but needs council review)
  return executeComplexPath(
    llm, options, request, decision,
    threadId, threadIds, taskId, journal, userId, sessionId,
    injectionQueue, getAbortSignal
  );
}

// ============================================
// EXECUTION PATHS
// ============================================

/**
 * Fast path: receptionist → persona → tool loop → judge → done.
 * Skips planner (receptionist already picked the persona) but still runs the judge
 * quality gate to catch raw data dumps, formatting issues, etc.
 * Used for high-confidence single-persona tasks — like Cascade, just do the thing.
 */
async function executeFastPath(
  llm: ILLMClient,
  options: AgentRunnerOptions,
  request: EnhancedPromptRequest,
  decision: ReceptionistDecision,
  targetPersona: PersonaDefinition,
  threadId: string,
  threadIds: string[],
  taskId: string | undefined,
  journal: RunJournal,
  userId: string,
  injectionQueue?: string[],
  getAbortSignal?: () => AbortSignal | undefined
): Promise<AgentRunResult> {
  journal.log("execution", "Fast path — executing with persona", {
    personaId: targetPersona.id,
    classification: decision.classification,
  });

  const execResult = await executeWithPersona(
    llm, options, targetPersona,
    decision.formattedRequest || request.prompt,
    request,
    injectionQueue,
    getAbortSignal,
    decision.modelRole,
    undefined, // extraToolCategories
    makeWaitCallback(taskId)
  );

  // Escalation: persona realized it doesn't have the right tools — re-route through planner
  if (execResult.escalated) {
    journal.log("escalation", "Persona escalated — re-routing through planner", {
      personaId: targetPersona.id,
      reason: execResult.escalationReason,
      neededTools: execResult.neededToolCategories,
    });
    log.info("Fast path escalated to complex path", {
      personaId: targetPersona.id,
      reason: execResult.escalationReason,
      neededTools: execResult.neededToolCategories,
    });

    // Stream the escalation message to the user so they know what's happening
    if (options.onStream) {
      options.onStream(targetPersona.id, execResult.response + "\n\n", false);
    }

    // Re-route through the planner with COMPOUND classification to force full planning
    const escalatedDecision: ReceptionistDecision = {
      ...decision,
      classification: "COMPOUND",
      personaId: undefined,
      confidence: 0.5,
      formattedRequest: decision.formattedRequest || request.prompt,
    };
    return executeComplexPath(
      llm, options, request, escalatedDecision,
      threadId, threadIds, taskId, journal, userId, "",
      injectionQueue, getAbortSignal
    );
  }

  let response = execResult.response;
  let workLog = execResult.workLog;

  // Judge — quality gate (catches raw JSON dumps, formatting issues, etc.)
  journal.log("judge", "Running quality check");
  let judgeResult = await runJudge(
    llm, options, request.prompt, response, targetPersona.id
  );

  if (judgeResult.verdict.verdict === "rerun") {
    journal.log("judge", "Verdict: rerun — re-executing persona", { personaId: targetPersona.id });
    const rerunResult = await executeWithPersona(
      llm, options, targetPersona,
      decision.formattedRequest || request.prompt,
      request,
      undefined, undefined,
      decision.modelRole
    );
    response = rerunResult.response;
    workLog = rerunResult.workLog || workLog;
    judgeResult = await runJudge(
      llm, options, request.prompt, response, targetPersona.id
    );
  }

  if (judgeResult.verdict.verdict === "cleaned") {
    journal.log("judge", "Response cleaned by judge");
  }
  response = judgeResult.response;

  // Save to thread WITH work log
  const threadResponse = workLog
    ? `${workLog}\n\n---\n\n${response}`
    : response;
  persistToThread(options, threadId, decision.newThreadTopic || request.prompt.substring(0, 80), request.prompt, threadResponse);
  completeTrackedTask(options, taskId, response);
  runUpdaterAsync(llm, options, request, response, [], decision, userId);

  journal.log("complete", "Fast path succeeded");
  return {
    success: true,
    response,
    classification: decision.classification,
    threadIds,
    keyPoints: [],
    taskId,
  };
}

/**
 * Simple path: writer response → judge. No tool loop.
 */
async function executeSimplePath(
  llm: ILLMClient,
  options: AgentRunnerOptions,
  request: EnhancedPromptRequest,
  decision: ReceptionistDecision,
  threadId: string,
  threadIds: string[],
  taskId: string | undefined,
  journal: RunJournal,
  userId: string
): Promise<AgentRunResult> {
  journal.log("execution", "Using simple response (no persona, no council)");
  let simpleResponse = await generateSimpleResponse(llm, options, request, decision);

  // Judge — final quality gate
  journal.log("judge", "Running quality check");
  let judgeResult = await runJudge(
    llm, options, request.prompt, simpleResponse, "writer"
  );

  if (judgeResult.verdict.verdict === "rerun") {
    journal.log("judge", "Verdict: rerun — re-generating simple response");
    simpleResponse = await generateSimpleResponse(llm, options, request, decision);
    judgeResult = await runJudge(
      llm, options, request.prompt, simpleResponse, "writer"
    );
  }

  if (judgeResult.verdict.verdict === "cleaned") {
    journal.log("judge", "Response cleaned by judge");
  }
  simpleResponse = judgeResult.response;

  persistToThread(options, threadId, decision.newThreadTopic || request.prompt.substring(0, 80), request.prompt, simpleResponse);
  completeTrackedTask(options, taskId, simpleResponse);
  runUpdaterAsync(llm, options, request, simpleResponse, [], decision, userId);
  return {
    success: true,
    response: simpleResponse,
    classification: decision.classification,
    threadIds,
    keyPoints: [],
    taskId,
  };
}

// ============================================
// HELPERS
// ============================================

/**
 * Resolve the thread ID from the request. Uses activeThreadId if available,
 * falls back to most recent thread from L0 index, or creates a new one.
 */
function resolveThreadId(request: EnhancedPromptRequest): string {
  let threadId = request.activeThreadId;

  // Fallback: if activeThreadId is null but L0 index has threads, use the most recent
  if (!threadId && request.threadIndex.threads.length > 0) {
    const sorted = [...request.threadIndex.threads].sort(
      (a, b) => (b.lastActive || "").localeCompare(a.lastActive || "")
    );
    threadId = sorted[0].id;
    log.info("activeThreadId was null — falling back to most recent thread from L0 index", { threadId });
  }

  // Only create a brand-new thread if no threads exist at all (first conversation ever)
  if (!threadId) {
    threadId = `thread_${nanoid(12)}`;
    log.info("No existing threads — creating first thread", { threadId });
  }

  return threadId;
}

/**
 * Heuristic: does this message contain multiple distinct items/requests?
 * 
 * Signals (need 2+ to trigger):
 * - Numbered items ("1.", "2.", etc.)
 * - Bullet points ("- item", "• item")
 * - Multiple sentences separated by periods with distinct topics
 * - Semicolons or "also" / "and also" / "additionally" splitting clauses
 * - Line breaks between distinct items
 * - Comma-separated imperative clauses ("delete X, merge Y, update Z")
 * 
 * Deliberately conservative — a normal multi-sentence message won't trigger this.
 * The goal is to catch lists of unrelated tasks stuffed into one message.
 */
function looksLikeMultipleItems(prompt: string): boolean {
  let signals = 0;

  // Numbered list items: "1.", "2)", "1:", etc.
  const numberedItems = prompt.match(/(?:^|\n)\s*\d+[\.\)\:]\s/gm);
  if (numberedItems && numberedItems.length >= 2) signals++;

  // Bullet points
  const bulletItems = prompt.match(/(?:^|\n)\s*[-•*]\s+\S/gm);
  if (bulletItems && bulletItems.length >= 2) signals++;

  // Line breaks separating substantive content (not just formatting)
  const lines = prompt.split(/\n+/).filter(l => l.trim().length > 15);
  if (lines.length >= 3) signals++;

  // Multiple distinct action verbs at sentence starts
  const actionStarts = prompt.match(/(?:^|[.!?\n]\s*)(?:delete|remove|merge|update|create|add|close|mark|send|fix|check|set|install|configure|move|rename|save)\s/gi);
  if (actionStarts && actionStarts.length >= 3) signals++;

  // Transition words suggesting additional unrelated items
  const transitions = prompt.match(/\b(?:also|additionally|and also|plus|another thing|on another note|separately|oh and|btw)\b/gi);
  if (transitions && transitions.length >= 1) signals++;

  // Parenthetical status markers like "(done)", "(completed)", "(close this)"
  const statusMarkers = prompt.match(/\((?:done|completed|close|finished|resolved|fixed)\)/gi);
  if (statusMarkers && statusMarkers.length >= 2) signals++;

  return signals >= 2;
}
