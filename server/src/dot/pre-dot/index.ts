/**
 * Pre-Dot — Barrel Exports
 *
 * The pre-Dot pipeline processes every user message before Dot sees it:
 *   1. Loader: reads principle .md files from disk
 *   2. Tailor (pass 1): selects applicable principles, restates request, scores complexity
 *   3. Consolidator (pass 2): merges applicable principle bodies into one unified briefing
 *   4. Assembler: fast fallback when consolidator is skipped or fails
 *   5. Prepare: orchestrates the full pre-dot pipeline, returns DotPreparedContext
 */

export type { PrincipleFile, TailorResult } from "./types.js";
export type { DotInternalContext } from "./prepare.js";
export { loadPrinciples } from "./loader.js";
export { buildTailorSchema, tailorPrinciples } from "./tailor.js";
export { consolidatePrinciples } from "./consolidator.js";
export { assembleTailoredPrinciples } from "./assembler.js";
export { prepareDot } from "./prepare.js";
