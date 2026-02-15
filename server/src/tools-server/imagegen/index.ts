/**
 * Image Generation — Barrel Exports
 *
 * Server-side image generation tools.
 * Provider selection and fallback are handled by IImageClient in llm/.
 *
 * Structure:
 *   types.ts      — ImageGenResult, ExecuteCommandFn, ImageData
 *   manifest.ts   — Tool definitions (IMAGEGEN_TOOLS)
 *   executor.ts   — Tool dispatcher + agent bridge I/O
 */

export { executeImageGenTool } from "./executor.js";
export { IMAGEGEN_TOOLS } from "./manifest.js";
export type { ImageGenResult, ExecuteCommandFn } from "./types.js";
