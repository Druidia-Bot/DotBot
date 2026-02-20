/**
 * Dot — Root-Level Conversational Assistant
 *
 * Dot is the user-facing assistant that sits at the root of every interaction.
 * She converses naturally, handles quick tasks with her own tools, and dispatches
 * complex work to the full pipeline when needed.
 *
 * Flow:
 *   1. prepareDot()  — (pre-dot/) build context, tailor principles, resolve prompt
 *   2. (caller saves resolvedPrompt to thread)
 *   3. runDot()       — build system prompt, run tool loop, return response
 *
 * Intake classification only runs when Dot dispatches to the pipeline.
 * Dot always starts with assistant. Tiered escalation mid-loop:
 *   iteration 6+ → workhorse (reasoning), iteration 10+ → architect (Opus).
 *
 * Decomposed modules:
 *   - dispatch-followup.ts — pipeline completion delivery + onDispatch closure
 *   - tool-context.ts      — server-side executor wiring (imagegen, premium, schedule)
 *   - loop-runner.ts       — multi-topic & single-topic tool loop execution
 *   - response-quality.ts  — quality gate check + assistant-model retry
 */

import { createComponentLogger } from "#logging.js";
import { resolveModelAndClient } from "#llm/selection/resolve.js";
import { buildDotSystemPrompt } from "./system-prompt.js";
import { sendRunLog } from "#ws/device-bridge.js";
import { buildDotTools } from "./tools/index.js";
import { buildOnDispatch } from "./dispatch-followup.js";
import { buildDotToolContext } from "./tool-context.js";
import { runDotToolLoop } from "./loop-runner.js";
import { retryWithAssistantModel } from "./response-quality.js";
import type { DotInternalContext } from "./pre-dot/index.js";
import type { DotOptions, DotPreparedContext, DotResult } from "./types.js";

const log = createComponentLogger("dot");

const DOT_MAX_TOKENS = 4096;

// ============================================
// MAIN ENTRY
// ============================================

/**
 * Runs Dot's tool loop using the prepared context from `prepareDot()`.
 *
 * The caller should save the resolved prompt to the conversation thread
 * between `prepareDot()` and this call.
 */
export async function runDot(opts: DotOptions, prepared: DotPreparedContext): Promise<DotResult> {
  const { llm, userId, deviceId, messageId, source } = opts;
  const ctx = prepared._internal as DotInternalContext;
  const {
    enhancedRequest,
    toolManifest,
    platform,
    modelSpines,
    tailorResult,
    consolidatedPrinciples,
    resolvedPrompt,
    forceDispatch,
    skillNudge,
    contextMs,
    dotStartTime,
  } = ctx;

  log.info("Dot starting tool loop", { messageId });

  // ── Build Dot's system prompt (stable identity + knowledge — no per-message content) ──
  const systemPrompt = await buildDotSystemPrompt(enhancedRequest, modelSpines, platform);

  // ── Always start with assistant — tiered escalation in loop-runner handles workhorse@6 and architect@10 ──
  const { selectedModel, client } = await resolveModelAndClient(llm, { explicitRole: "assistant" }, deviceId);
  log.info("Dot model selected", { model: selectedModel.model, maxTokens: DOT_MAX_TOKENS });

  // ── Dispatch closure (fire-and-forget so Dot responds immediately) ──
  const { onDispatch, getDispatchResult } = buildOnDispatch({
    llm, userId, deviceId, messageId, enhancedRequest, modelSpines, platform,
  });

  // ── Build tool set + context ──
  const { definitions: tools, handlers, toolHintsById } = buildDotTools(toolManifest, onDispatch);
  const toolCtx = buildDotToolContext({ deviceId, userId, client });

  // ── Run tool loop (multi-topic or single-topic) ──
  const loopResult = await runDotToolLoop({
    messageId, systemPrompt, deviceId, client, selectedModel, maxTokens: DOT_MAX_TOKENS,
    tools, toolHintsById, handlers, toolCtx,
    tailorResult, consolidatedPrinciples, resolvedPrompt,
    forceDispatch, skillNudge, onStream: opts.onStream,
    llm,
  });

  let { response } = loopResult;
  const { toolCalls: totalToolCalls, iterations: totalIterations } = loopResult;

  // ── Max iterations handoff: dispatch everything Dot knows to an agent ──
  if (loopResult.maxIterationsReached && totalToolCalls.length > 0) {
    log.info("Dot hit max iterations — handing off to agent", { messageId, iterations: totalIterations, toolCalls: totalToolCalls.length });

    const handoffSummary = totalToolCalls
      .map(tc => `- ${tc.tool}: ${tc.success ? "OK" : "FAILED"} — ${(tc.result || "").slice(0, 200)}`)
      .join("\n");

    const handoffPrompt = [
      `Continue this task that I started but couldn't finish in ${totalIterations} iterations.`,
      "",
      `Original request: ${resolvedPrompt}`,
      "",
      `Here's what I've done so far (${totalToolCalls.length} tool calls):`,
      handoffSummary,
      "",
      response ? `My last response/thinking:\n${response.slice(0, 1000)}` : "",
      "",
      "Pick up where I left off. Do NOT repeat work that already succeeded.",
    ].filter(Boolean).join("\n");

    await onDispatch(handoffPrompt);
    response = "This task needs more work than I can handle in one go — I've dispatched it to an agent with everything I've done so far. I'll follow up when it's complete.";
  }

  // ── Quality gate: detect truncated/garbage responses and retry with non-reasoning model ──
  if (!loopResult.maxIterationsReached && totalIterations >= 6 && response && totalToolCalls.length > 0) {
    response = await retryWithAssistantModel({
      llm, deviceId, messageId, systemPrompt, resolvedPrompt, response, toolCalls: totalToolCalls,
    });
  }

  const totalMs = Date.now() - dotStartTime;
  const usePerTopicLoop = (tailorResult.topicSegments || []).length >= 2;
  const dispatchResult = getDispatchResult();

  // ── Persist run-log ──
  sendRunLog(userId, {
    stage: "dot-complete",
    messageId,
    source,
    model: selectedModel.model,
    provider: selectedModel.provider,
    toolCallCount: totalToolCalls.length,
    tools: totalToolCalls.map(t => ({
      id: t.tool,
      ok: t.success,
      len: t.result?.length || 0,
    })),
    dispatched: false,
    iterations: totalIterations,
    responseLength: response.length,
    responsePreview: response.slice(0, 200),
    perTopicLoop: usePerTopicLoop,
    segmentCount: usePerTopicLoop ? (tailorResult.topicSegments || []).length : 1,
    contextMs,
    totalMs,
    timestamp: new Date().toISOString(),
  });

  log.info("Dot complete", {
    messageId,
    dispatched: !!dispatchResult,
    toolCalls: totalToolCalls.length,
    responseLength: response.length,
    perTopicLoop: usePerTopicLoop,
  });

  return {
    response,
    dispatched: !!dispatchResult,
    threadId: prepared.threadId,
    dispatch: dispatchResult,
  };
}
