/**
 * Tool Manifest Utilities
 *
 * Converts the dynamic tool manifest from the local agent's plugin registry
 * into native ToolDefinition[] for LLM function calling.
 */

import type { ToolDefinition } from "#llm/types.js";
import type { ToolManifestEntry } from "./types.js";

/**
 * Sanitize a tool ID for use as a native function name.
 * OpenAI/Anthropic restrict names to [a-zA-Z0-9_-], so dots become double underscores.
 */
export function sanitizeToolName(id: string): string {
  return id.replace(/\./g, "__");
}

/**
 * Reverse sanitizeToolName — convert double underscores back to dots.
 */
export function unsanitizeToolName(name: string): string {
  return name.replace(/__/g, ".");
}

/**
 * Convert a tool manifest into native ToolDefinition[] for the LLM's tools parameter.
 * Tool IDs are sanitized (dots → __) to comply with function name restrictions.
 * Returns an empty array if no manifest is provided.
 */
export function manifestToNativeTools(manifest?: ToolManifestEntry[]): ToolDefinition[] {
  if (!manifest || manifest.length === 0) return [];

  return manifest.map(t => ({
    type: "function" as const,
    function: {
      name: sanitizeToolName(t.id),
      description: t.description,
      parameters: {
        type: "object",
        properties: t.inputSchema?.properties || {},
        required: t.inputSchema?.required || [],
      },
    },
  }));
}
