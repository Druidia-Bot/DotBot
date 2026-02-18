/**
 * Dot Tool Types
 *
 * Typed definition interface for Dot-native tools, mirroring
 * CoreToolDefinition from server/src/tools/core-registry.ts
 * but with Dot-specific hint fields.
 */

/** Behavior hints consumed by the tool loop's verification/mutation tracking. */
export interface DotToolHints {
  /** Tool performs state mutations (writes, creates, deletes). */
  mutating?: boolean;
  /** Tool is a read-only verification/inspection call. */
  verification?: boolean;
}

/** Category groupings for Dot-native tools. */
export type DotToolCategory =
  | "dispatch"
  | "skill"
  | "identity"
  | "backstory"
  | "logs"
  | "agent"
  | "tools";

/**
 * Declarative definition for a Dot-native tool.
 *
 * These are pure data objects — handlers live separately in handlers/.
 * The registry converts these to LLM-native ToolDefinition format
 * via dotToolsToNative().
 */
export interface DotToolDefinition {
  /** Canonical tool ID using dot notation (e.g., "skill.search"). */
  id: string;
  /** LLM function name (dots replaced with __), e.g., "skill__search". */
  name: string;
  /** LLM-facing description of what the tool does. */
  description: string;
  /** Logical grouping for registry lookups. */
  category: DotToolCategory;
  /** JSON Schema for the tool's input parameters. */
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
  /** Behavior hints for the Dot verification loop. */
  hints: DotToolHints;
}
