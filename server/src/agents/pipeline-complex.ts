/**
 * Pipeline — Complex Path & Helpers
 * 
 * Extracted from pipeline.ts to keep file sizes manageable.
 * Contains the planner-driven complex execution path and shared helpers
 * (council review, thread context).
 */

import { getPersona, getInternalPersonas } from "../personas/loader.js";
import type { ILLMClient } from "../llm/providers.js";
import type { CouncilReviewResult } from "../types.js";
import { CouncilReviewRunner } from "../council/review-runner.js";
import { createComponentLogger } from "../logging.js";
import type {
  EnhancedPromptRequest,
  ReceptionistDecision,
  ThreadPacket,
  PersonaDefinition,
} from "../types/agent.js";
import type { AgentRunnerOptions, AgentRunResult } from "./runner-types.js";
import { runPlanner, runChairman, runJudge, runUpdaterAsync } from "./intake.js";
import { executePlan, executeWithPersona } from "./execution.js";
import { completeTrackedTask, persistToThread } from "./task-tracking.js";
import { blockTask } from "./agent-tasks.js";
import type { RunJournal } from "./self-recovery.js";

const log = createComponentLogger("pipeline.complex");

/** Create an onWaitForUser callback bound to a specific task, or undefined if no taskId. */
function makeWaitCallback(taskId: string | undefined) {
  return taskId
    ? (reason: string, resumeHint?: string, timeoutMs?: number) => blockTask(taskId, reason, resumeHint, timeoutMs)
    : undefined;
}

// ============================================
// COMPLEX PATH
// ============================================

/**
 * Complex path: planner → execute tasks → chairman → council → judge.
 */
export async function executeComplexPath(
  llm: ILLMClient,
  options: AgentRunnerOptions,
  request: EnhancedPromptRequest,
  decision: ReceptionistDecision,
  threadId: string,
  threadIds: string[],
  taskId: string | undefined,
  journal: RunJournal,
  userId: string,
  sessionId: string,
  injectionQueue?: string[],
  getAbortSignal?: () => AbortSignal | undefined
): Promise<AgentRunResult> {
  // Get thread context + all internal personas (with tools) for the planner
  journal.log("planner", "Complex task — entering planner pipeline");
  const { packets, personas: userPersonas } = await getThreadContext(options, decision);
  const internalPersonas = getInternalPersonas().filter(p => !p.councilOnly);
  // Merge: user-defined personas + all internal personas (deduplicated)
  const seenIds = new Set(userPersonas.map(p => p.id));
  const allPersonas = [...userPersonas, ...internalPersonas.filter(p => !seenIds.has(p.id))];

  journal.log("planner", `Planner sees ${allPersonas.length} personas`, {
    personas: allPersonas.map(p => `${p.id} [${p.tools?.join(", ") || "no tools"}]`),
  });

  // Planner creates execution plan — assigns best persona per step
  const plan = await runPlanner(
    llm, options,
    decision.formattedRequest || request.prompt,
    packets,
    allPersonas
  );

  journal.log("planner", "Plan created", {
    taskCount: plan.tasks.length,
    tasks: plan.tasks.map(t => `${t.id}: ${t.personaId} → "${t.description.substring(0, 80)}"`),
    reasoning: plan.reasoning,
  });

  log.info("Planner created plan", {
    taskCount: plan.tasks.length,
    estimatedMs: plan.totalEstimatedMs,
    tasks: plan.tasks.map(t => ({ id: t.id, persona: t.personaId, desc: t.description.substring(0, 100) })),
    reasoning: plan.reasoning,
  });

  const taskResults = await executePlan(
    llm, options, plan, sessionId, userId, packets, request,
    injectionQueue, getAbortSignal, makeWaitCallback(taskId)
  );

  let finalResponse: string;
  let keyPoints: string[] = [];
  let councilReview: CouncilReviewResult | undefined;
  const isSingleTask = plan.tasks.length === 1;

  if (isSingleTask) {
    // Single-task plan — no chairman synthesis needed, the persona's output IS the response.
    // This keeps latency low for simple requests routed through the planner.
    const soleResult = taskResults.values().next().value;
    finalResponse = soleResult?.response || "No response generated.";
    journal.log("pipeline", "Single-task plan — skipping chairman synthesis");
  } else {
    // Multi-task plan — chairman synthesizes outputs from multiple personas
    journal.log("chairman", "Multi-task plan — Chairman synthesizing team outputs");
    const chairmanResponse = await runChairman(
      llm, request.prompt, decision, taskResults, packets
    );
    finalResponse = chairmanResponse.response;
    keyPoints = chairmanResponse.keyPoints || [];
  }

  // Council review — polish the output if a council was selected
  if (decision.reviewCouncilSlug) {
    councilReview = await runCouncilReviewStep(
      options, decision.reviewCouncilSlug, request.prompt, finalResponse
    );
    if (councilReview) {
      finalResponse = applyCouncilFeedback(finalResponse, councilReview);
    }
  }

  // Judge — final quality gate
  const judgePersonaLabel = isSingleTask
    ? (taskResults.values().next().value?.personaId || "unknown")
    : "chairman";
  journal.log("judge", "Running quality check");
  let judgeResult = await runJudge(
    llm, options, request.prompt, finalResponse, judgePersonaLabel
  );

  if (judgeResult.verdict.verdict === "rerun" && !isSingleTask) {
    journal.log("judge", "Verdict: rerun — re-synthesizing via Chairman");
    const retryChairman = await runChairman(
      llm, request.prompt, decision, taskResults, packets
    );
    finalResponse = retryChairman.response;
    judgeResult = await runJudge(
      llm, options, request.prompt, finalResponse, "chairman"
    );
  } else if (judgeResult.verdict.verdict === "rerun" && isSingleTask) {
    // For single-task reruns, re-execute the task
    journal.log("judge", "Verdict: rerun — re-executing single task");
    const task = plan.tasks[0];
    const persona = getPersona(task.personaId) || getPersona("writer")!;
    const rerunResult = await executeWithPersona(
      llm, options, persona,
      decision.formattedRequest || request.prompt,
      request, injectionQueue, getAbortSignal
    );
    finalResponse = rerunResult.response;
    judgeResult = await runJudge(
      llm, options, request.prompt, finalResponse, persona.id
    );
  }

  if (judgeResult.verdict.verdict === "cleaned") {
    journal.log("judge", "Response cleaned by judge");
  }
  finalResponse = judgeResult.response;

  // Persist to thread + task + Updater
  persistToThread(options, threadId, decision.newThreadTopic || request.prompt.substring(0, 80), request.prompt, finalResponse);
  completeTrackedTask(options, taskId, finalResponse);
  runUpdaterAsync(llm, options, request, finalResponse, keyPoints, decision, userId);

  journal.log("complete", `Pipeline succeeded (${isSingleTask ? "single-task" : "multi-task"} plan)`);
  return {
    success: true,
    response: finalResponse,
    classification: decision.classification,
    threadIds,
    keyPoints,
    councilReview,
    taskId,
  };
}

// ============================================
// HELPERS
// ============================================

/**
 * Run a council review step. Returns the review result or undefined on failure.
 */
export async function runCouncilReviewStep(
  options: AgentRunnerOptions,
  councilSlug: string,
  originalPrompt: string,
  workOutput: string
): Promise<CouncilReviewResult | undefined> {
  if (!options.onLoadCouncil) {
    log.warn("Council review requested but no onLoadCouncil callback configured");
    return undefined;
  }

  try {
    const council = await options.onLoadCouncil(councilSlug);
    if (!council) {
      log.warn(`Council not found: ${councilSlug}`);
      return undefined;
    }

    log.info(`Running council review: ${council.name}`, {
      slug: councilSlug,
      mode: council.executionMode,
      members: council.members.map(m => m.personaSlug),
    });

    const runner = new CouncilReviewRunner({
      defaultProvider: (options.provider || "deepseek") as any,
      defaultApiKey: options.apiKey,
      apiKeys: options.councilApiKeys as any,
      onMemberReview: (member, verdict) => {
        options.onStream?.(
          `council:${member.personaSlug}`,
          `[${member.councilRole}] ${verdict.approved ? "✓ Approved" : "✗ Rejected"}: ${verdict.feedback.substring(0, 200)}`,
          true
        );
      },
    });

    const result = await runner.review(council, originalPrompt, workOutput);

    log.info(`Council review complete: ${council.name}`, {
      approved: result.approved,
      iterations: result.totalIterations,
    });

    return result;
  } catch (error) {
    log.error("Council review failed", { councilSlug, error });
    return undefined;
  }
}

/**
 * Apply council feedback to the work output if not approved.
 */
export function applyCouncilFeedback(
  workOutput: string,
  review: CouncilReviewResult
): string {
  if (review.approved) return workOutput;

  const rejections = review.iterations[review.iterations.length - 1]?.verdicts
    .filter(v => !v.approved) || [];
  if (rejections.length === 0) return workOutput;

  const feedbackNote = rejections
    .map(v => `**${v.councilRole}:** ${v.feedback}${v.suggestedChanges ? `\n_Suggested: ${v.suggestedChanges}_` : ""}`)
    .join("\n\n");

  return `${workOutput}\n\n---\n**Council Review (${review.councilSlug})** — Flagged for review:\n\n${feedbackNote}`;
}

/**
 * Fetch thread context (packets + personas) from local agent.
 */
export async function getThreadContext(
  options: AgentRunnerOptions,
  decision: ReceptionistDecision
): Promise<{
  packets: ThreadPacket[];
  personas: PersonaDefinition[];
}> {
  if (!options.onRequestThreadData) {
    return { packets: [], personas: [] };
  }

  const result = await options.onRequestThreadData(
    2,
    decision.threadIds,
    decision.councilId
  );

  return {
    packets: result.packets || [],
    personas: result.personas || [],
  };
}
