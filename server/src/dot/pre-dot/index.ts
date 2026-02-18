/**
 * Pre-Dot — Barrel Exports
 *
 * The pre-Dot pipeline processes every user message before Dot sees it:
 *   1. Loader: reads principle .md files from disk (rules + principles)
 *   2. Tailor: resolves context, scores complexity, matches models (LLM call)
 *   3. Selector: rule-based principle selection (no LLM — complexity + keyword matching)
 *   4. Consolidator: merges rules + selected principles into unified briefing (LLM call)
 *   5. Prepare: orchestrates the full pre-dot pipeline, returns DotPreparedContext
 */

export type { PrincipleFile, TailorResult, RelevantMemory } from "./types.js";
export type { DotInternalContext } from "./prepare.js";
export { loadPrinciples } from "./loader.js";
export { buildTailorSchema, tailorPrinciples } from "./tailor.js";
export { selectPrinciples } from "./selector.js";
export { consolidatePrinciples } from "./consolidator.js";
export { prepareDot } from "./prepare.js";
