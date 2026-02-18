/**
 * Dot Tool Registry
 *
 * Canonical registry of Dot tool definitions.
 * DOT_NATIVE_TOOLS = DOT_EXCLUSIVE_TOOLS + SHARED_SERVER_TOOLS.
 * Provides lookup functions and LLM-native format conversion.
 */

import type { ToolDefinition } from "#llm/types.js";
import type { DotToolDefinition, DotToolCategory, DotToolHints } from "./types.js";
import { DOT_NATIVE_TOOLS, DOT_EXCLUSIVE_TOOLS } from "./definitions/dot-native.js";

export { DOT_NATIVE_TOOLS, DOT_EXCLUSIVE_TOOLS } from "./definitions/dot-native.js";
export { SHARED_SERVER_TOOLS } from "#tools/definitions/server-tools.js";

// ── Index ─────────────────────────────────────────────────

const toolIndex = new Map<string, DotToolDefinition>();
for (const tool of DOT_NATIVE_TOOLS) {
  toolIndex.set(tool.id, tool);
}

// ── Lookups ───────────────────────────────────────────────

export function getDotToolById(id: string): DotToolDefinition | undefined {
  return toolIndex.get(id);
}

export function getDotToolsByCategory(category: DotToolCategory): DotToolDefinition[] {
  return DOT_NATIVE_TOOLS.filter(t => t.category === category);
}

export function getDotToolCount(): number {
  return DOT_NATIVE_TOOLS.length;
}

export function getDotCategories(): DotToolCategory[] {
  return [...new Set(DOT_NATIVE_TOOLS.map(t => t.category))];
}

// ── Native Conversion ─────────────────────────────────────

/**
 * Convert DotToolDefinition[] to native LLM ToolDefinition[] format.
 * Tool names use the pre-sanitized `name` field (already dots → __).
 */
export function dotToolsToNative(tools: DotToolDefinition[]): ToolDefinition[] {
  return tools.map(t => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: "object",
        properties: t.inputSchema.properties || {},
        required: t.inputSchema.required || [],
      },
    },
  }));
}

// ── Hints Extraction ──────────────────────────────────────

/**
 * Build the toolHintsById record from the registry.
 * Returns { [toolId]: { mutating, verification } } for all Dot-native tools.
 */
export function getDotToolHints(): Record<string, DotToolHints> {
  const hints: Record<string, DotToolHints> = {};
  for (const tool of DOT_NATIVE_TOOLS) {
    hints[tool.id] = tool.hints;
  }
  return hints;
}
