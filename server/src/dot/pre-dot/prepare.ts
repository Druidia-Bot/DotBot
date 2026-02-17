/**
 * Pre-Dot — Prepare
 *
 * Orchestrates the full pre-dot pipeline:
 *   1. Build context + fetch memory/principles/cache in parallel
 *   2. Tailor principles (pass 1)
 *   3. Consolidate principles (pass 2)
 *   4. Resolve prompt (restated or raw)
 *
 * Returns a DotPreparedContext that the caller saves to the thread,
 * then passes to runDot().
 */

import { createComponentLogger } from "#logging.js";
import { buildRequestContext } from "#pipeline/context/context-builder.js";
import { fetchAllModelSpines, fetchResearchCacheIndex } from "#pipeline/context/memory.js";
import { sendRunLog } from "#ws/device-bridge.js";
import { loadPrinciples } from "./loader.js";
import { tailorPrinciples } from "./tailor.js";
import { consolidatePrinciples } from "./consolidator.js";
import type { DotOptions, DotPreparedContext } from "../types.js";

const log = createComponentLogger("dot.prepare");

const AUTO_DISPATCH_THRESHOLD = 8;

// ============================================
// INTERNAL CONTEXT (opaque to callers)
// ============================================

export interface DotInternalContext {
  enhancedRequest: any;
  toolManifest: any[];
  platform: any;
  modelSpines: { model: any; spine: string }[];
  tailorResult: any;
  consolidatedPrinciples: string;
  resolvedPrompt: string;
  forceDispatch: boolean;
  contextMs: number;
  dotStartTime: number;
}

// ============================================
// PREPARE (pre-dot orchestrator)
// ============================================

/**
 * Pre-dot phase: builds context, tailors principles, resolves the prompt.
 *
 * Call this first, save `resolvedPrompt` to the conversation thread,
 * then pass the result to `runDot()`.
 */
export async function prepareDot(opts: DotOptions): Promise<DotPreparedContext> {
  const { llm, prompt, deviceId, userId, messageId, source } = opts;

  log.info("Preparing context", { messageId, promptLength: prompt.length });

  const dotStartTime = Date.now();

  // ── Step 1: Build context + fetch model spines + load principles + cache index in parallel ──
  const [{ enhancedRequest, toolManifest, platform }, modelSpines, principles, cacheIndex] = await Promise.all([
    buildRequestContext(deviceId, userId, prompt),
    fetchAllModelSpines(deviceId),
    loadPrinciples(),
    fetchResearchCacheIndex(deviceId),
  ]);

  // ── Strip inline attachments before tailoring ──
  // File content is irrelevant to principle selection and context resolution.
  // We strip it here, send only the conversational text to the tailor, then
  // re-append the attachment blocks to the resolved prompt so Dot gets the full data.
  const attachmentRegex = /\n*--- BEGIN ATTACHED FILE: .+? ---[\s\S]*?--- END ATTACHED FILE: .+? ---/g;
  const attachmentBlocks = prompt.match(attachmentRegex) || [];
  const strippedPrompt = prompt.replace(attachmentRegex, "").trim();

  // ── Step 1b: Tailor principles (runs against fast LLM with conversation context) ──
  const tailorResult = await tailorPrinciples({
    llm,
    prompt: strippedPrompt,
    recentHistory: enhancedRequest.recentHistory,
    principles,
    modelSpines,
    cacheIndex,
    deviceId,
  });

  const contextMs = Date.now() - dotStartTime;

  // Use the restated request if the tailor resolved context, otherwise the stripped prompt.
  // Then re-append any attachment blocks so Dot receives the full file content.
  const basePrompt = tailorResult.restatedRequest || strippedPrompt;
  const resolvedPrompt = attachmentBlocks.length > 0
    ? basePrompt + "\n\n" + attachmentBlocks.join("\n\n")
    : basePrompt;

  // Persist run-log
  sendRunLog(userId, {
    stage: "dot-start",
    messageId,
    source,
    prompt: prompt.slice(0, 500),
    restatedRequest: resolvedPrompt !== prompt ? resolvedPrompt.slice(0, 500) : undefined,
    complexity: tailorResult.complexity,
    relevantModels: tailorResult.relevantModels || [],
    manufacturedHistoryCount: tailorResult.manufacturedHistory?.length || 0,
    topicSegmentCount: tailorResult.topicSegments?.length || 0,
    memoryModelCount: modelSpines.length,
    historyCount: enhancedRequest.recentHistory?.length || 0,
    threadId: enhancedRequest.activeThreadId || null,
    hasIdentity: !!enhancedRequest.agentIdentity,
    taskCount: enhancedRequest.activeTasks?.length || 0,
    historyPreview: enhancedRequest.recentHistory?.slice(-2).map(
      (h: any) => `[${h.role}] ${(h.content || "").slice(0, 80)}`
    ),
    contextMs,
    timestamp: new Date().toISOString(),
  });

  // ── Forced-dispatch flag: complexity >= threshold means Dot MUST dispatch ──
  const complexity = tailorResult.complexity ?? 0;
  const forceDispatch = complexity >= AUTO_DISPATCH_THRESHOLD;
  if (forceDispatch) {
    log.info("Force-dispatch flagged (complexity >= threshold)", {
      complexity,
      threshold: AUTO_DISPATCH_THRESHOLD,
      messageId,
    });
  }

  // ── Step 1c: Consolidate principles (pass 2 — merges applicable principle bodies into one briefing) ──
  const consolidatedPrinciples = await consolidatePrinciples({ llm, tailorResult, userId, deviceId });

  const threadId = enhancedRequest.activeThreadId || "conversation";

  return {
    resolvedPrompt,
    threadId,
    _internal: {
      enhancedRequest,
      toolManifest,
      platform,
      modelSpines,
      tailorResult,
      consolidatedPrinciples,
      resolvedPrompt,
      forceDispatch,
      contextMs,
      dotStartTime,
    } satisfies DotInternalContext,
  };
}
