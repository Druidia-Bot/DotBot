/**
 * Dot Tools — Barrel Export
 */

// Builder (primary consumer entry point)
export { buildDotTools } from "./builder.js";
export type { DotToolSetup } from "./builder.js";

// Registry (for inspection, testing, tooling)
export {
  DOT_NATIVE_TOOLS,
  DOT_EXCLUSIVE_TOOLS,
  SHARED_SERVER_TOOLS,
  getDotToolById,
  getDotToolsByCategory,
  getDotToolCount,
  getDotCategories,
  dotToolsToNative,
  getDotToolHints,
} from "./dot-registry.js";

// Types
export type { DotToolDefinition, DotToolHints, DotToolCategory } from "./types.js";
export type { ServerToolDefinition, ServerToolHints, ServerToolCategory } from "#tools/definitions/server-tools.js";
