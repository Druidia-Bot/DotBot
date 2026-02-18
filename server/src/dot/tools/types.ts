/**
 * Dot Tool Types
 *
 * Extends the shared ServerToolDefinition with Dot-exclusive categories
 * (dispatch, identity, backstory). The base type and shared categories
 * live in server/src/tools/definitions/server-tools.ts.
 */

import type {
  ServerToolDefinition,
  ServerToolHints,
  ServerToolCategory,
} from "#tools/definitions/server-tools.js";

/** Re-export the shared hints type — same for Dot and agents. */
export type DotToolHints = ServerToolHints;

/** Dot-exclusive categories + all shared categories. */
export type DotToolCategory =
  | ServerToolCategory
  | "dispatch"
  | "identity"
  | "backstory";

/**
 * Tool definition for Dot — extends ServerToolDefinition with
 * Dot-exclusive categories. Structurally identical otherwise.
 */
export interface DotToolDefinition extends Omit<ServerToolDefinition, "category" | "hints"> {
  category: DotToolCategory;
  hints: DotToolHints;
}
