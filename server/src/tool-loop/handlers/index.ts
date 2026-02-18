/**
 * Tool Handler Registry
 *
 * Composes handler maps in layers for different callers. All server-side
 * handler definitions live in server-side-handlers.ts (single source of truth).
 *
 * This file provides two builder functions:
 *   - buildStepExecutorHandlers  — lightweight (planner step loops)
 *   - buildExecutionHandlers     — full-featured (executeWithPersona)
 */

import type { ToolHandler } from "../types.js";
import type { ToolManifestEntry } from "#tools/types.js";
import type { ToolDefinition } from "#llm/types.js";
import { buildProxyHandlers } from "./local-agent-proxy.js";
import { wrapHandlersWithResearch } from "./research-wrapper.js";
import { buildServerSideHandlers } from "./server-side-handlers.js";
import { buildToolsListHandler } from "./tools-list.js";
import { withScreenshotExtraction } from "./screenshot-handler.js";
import { buildSyntheticTools, type SyntheticToolsConfig } from "./synthetic-tools.js";

// ── Re-exports ──────────────────────────────────────────────────────

export { buildProxyHandlers } from "./local-agent-proxy.js";
export { wrapHandlersWithResearch, withResearchPersistence } from "./research-wrapper.js";
export { buildServerSideHandlers, getMemoryHandlers, getKnowledgeHandlers } from "./server-side-handlers.js";
export { buildToolsListHandler } from "./tools-list.js";
export { withScreenshotExtraction } from "./screenshot-handler.js";
export {
  buildSyntheticTools,
  escalateToolDefinition, waitForUserToolDefinition,
  requestToolsToolDefinition, requestResearchToolDefinition,
  ESCALATE_TOOL_ID, WAIT_FOR_USER_TOOL_ID,
  REQUEST_TOOLS_TOOL_ID, REQUEST_RESEARCH_TOOL_ID,
} from "./synthetic-tools.js";

// ── Helpers ─────────────────────────────────────────────────────────

/** Merge all entries from `source` into `target` (source wins on conflict). */
function mergeInto(target: Map<string, ToolHandler>, source: Map<string, ToolHandler>): void {
  for (const [id, handler] of source) target.set(id, handler);
}

/** Build a toolId → category lookup from a manifest. */
function buildCategoryMap(manifest: ToolManifestEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of manifest) {
    if (entry.category) map.set(entry.id, entry.category);
  }
  return map;
}

// ── Builders ────────────────────────────────────────────────────────

/**
 * Handler map for the step executor (planner pipeline).
 *
 * Layers:
 *   1. Local agent proxy
 *   2. Research persistence
 *   3. Server-side overrides (memory, knowledge, dynamic categories)
 */
export function buildStepExecutorHandlers(
  manifest: ToolManifestEntry[],
  workspacePath: string,
): Map<string, ToolHandler> {
  const handlers = buildProxyHandlers(manifest);
  const categoryMap = buildCategoryMap(manifest);

  const wrapped = wrapHandlersWithResearch(handlers, workspacePath, categoryMap);
  mergeInto(wrapped, buildServerSideHandlers(manifest));
  wrapped.set("tools.list_tools", buildToolsListHandler(manifest));

  return wrapped;
}

/**
 * Full handler map + synthetic tool definitions for execution.ts.
 *
 * Layers:
 *   1. Local agent proxy (category-aware timeouts, sandboxing)
 *   2. Server-side handlers (memory, knowledge, premium, imagegen, schedule, research)
 *   3. Screenshot extraction (images → LLM content blocks)
 *   4. Research persistence (saves + summarizes large results)
 *   5. Synthetic tools (escalate, wait_for_user, request_tools, request_research)
 */
export function buildExecutionHandlers(
  manifest: ToolManifestEntry[],
  options: { workspacePath?: string; syntheticConfig?: SyntheticToolsConfig } = {},
): { handlers: Map<string, ToolHandler>; syntheticDefinitions: ToolDefinition[] } {
  const handlers = buildProxyHandlers(manifest);

  // Server-side overrides
  mergeInto(handlers, buildServerSideHandlers(manifest));
  handlers.set("tools.list_tools", buildToolsListHandler(manifest));

  // Screenshot extraction (wraps every handler registered so far)
  for (const [id, handler] of handlers) {
    handlers.set(id, withScreenshotExtraction(id, handler));
  }

  // Research persistence
  if (options.workspacePath) {
    mergeInto(handlers, wrapHandlersWithResearch(handlers, options.workspacePath, buildCategoryMap(manifest)));
  }

  // Synthetic tools
  const { definitions: syntheticDefinitions, handlers: syntheticHandlers } =
    buildSyntheticTools(options.syntheticConfig || {});
  mergeInto(handlers, syntheticHandlers);

  return { handlers, syntheticDefinitions };
}
