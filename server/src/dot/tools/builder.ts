/**
 * Dot Tools — Builder
 *
 * Assembles Dot's complete tool set from:
 *   1. Proxy handlers for the FULL manifest (every tool callable)
 *   2. Server-side handlers (memory.*, knowledge.*)
 *   3. Dot-native tools (from dot-registry)
 *   4. tools.execute — generic passthrough for any tool by ID
 *
 * Only a curated subset of definitions is sent to the LLM to keep
 * the context window small. Dot discovers additional tools via
 * `tools.list_tools` and calls them through `tools.execute`.
 */

import { manifestToNativeTools } from "#tools/manifest.js";
import {
  buildProxyHandlers,
  buildServerSideHandlers,
} from "#tool-loop/handlers/index.js";
import type { ToolDefinition } from "#llm/types.js";
import type { ToolHandler } from "#tool-loop/types.js";
import type { ToolManifestEntry } from "#tools/types.js";
import { DOT_PROXY_CATEGORIES } from "../types.js";

import { DOT_NATIVE_TOOLS, dotToolsToNative, getDotToolHints } from "./dot-registry.js";

import { taskDispatchHandler } from "./handlers/dispatch.js";
import { skillSearchHandler, skillReadHandler, skillCreateHandler, skillDeleteHandler } from "./handlers/skills.js";
import { identityReadHandler, identityUpdateHandler, identityRemoveHandler } from "./handlers/identity.js";
import { backstoryGenerateHandler } from "./handlers/backstory.js";
import { logsListHandler, logsReadHandler, logsSearchHandler } from "./handlers/logs.js";
import { agentStatusHandler } from "./handlers/agent-status.js";
import { toolExecuteHandler } from "./handlers/execute.js";

// ============================================
// TYPES
// ============================================

export interface DotToolSetup {
  /** Native tool definitions for the LLM API. */
  definitions: ToolDefinition[];
  /** Handler map (toolId → handler). */
  handlers: Map<string, ToolHandler>;
  /** Behavior hints for Dot verification loop keyed by tool ID. */
  toolHintsById: Record<string, { mutating?: boolean; verification?: boolean }>;
}

// ============================================
// HANDLER FACTORY MAP
// ============================================

/**
 * Maps tool IDs to their no-arg handler factories.
 * Closure-based handlers (task.dispatch, tools.execute) are
 * registered separately in buildDotTools() since they need
 * runtime arguments.
 */
const SIMPLE_HANDLER_FACTORIES: Record<string, () => ToolHandler> = {
  "skill.search":       skillSearchHandler,
  "skill.read":         skillReadHandler,
  "skill.create":       skillCreateHandler,
  "skill.delete":       skillDeleteHandler,
  "identity.read":      identityReadHandler,
  "identity.update":    identityUpdateHandler,
  "identity.remove":    identityRemoveHandler,
  "backstory.generate": backstoryGenerateHandler,
  "logs.list":          logsListHandler,
  "logs.read":          logsReadHandler,
  "logs.search":        logsSearchHandler,
  "agent.status":       agentStatusHandler,
};

// ============================================
// BUILDER
// ============================================

export function buildDotTools(
  manifest: ToolManifestEntry[],
  onDispatch: (prompt: string) => Promise<{
    agentId?: string;
    workspacePath?: string;
    success?: boolean;
    executionResponse?: string;
  }>,
): DotToolSetup {
  // Curated categories whose definitions are sent to the LLM
  const dotManifest = manifest.filter(t => {
    const category = t.category || t.id.split(".")[0] || "";
    return DOT_PROXY_CATEGORIES.has(category);
  });

  // Layer 1: proxy handlers for the FULL manifest (Dot can call anything)
  const handlers = buildProxyHandlers(manifest);

  // Layer 2: server-side handlers (memory, knowledge) — full manifest
  mergeInto(handlers, buildServerSideHandlers(manifest));

  // Layer 3: Dot-native tools (simple factories)
  for (const [id, factory] of Object.entries(SIMPLE_HANDLER_FACTORIES)) {
    handlers.set(id, factory());
  }

  // Layer 3b: Closure-based handlers
  handlers.set("task.dispatch", taskDispatchHandler(onDispatch));

  // Layer 4: tools.execute — generic passthrough (needs complete handler map)
  handlers.set("tools.execute", toolExecuteHandler(handlers));

  // Build native tool definitions — only curated categories + Dot-specific
  const proxyDefs = manifestToNativeTools(dotManifest) || [];
  const dotDefs = dotToolsToNative(DOT_NATIVE_TOOLS);

  // Hints: manifest-derived + dot-native (from definitions)
  const toolHintsById = buildCombinedHints(manifest);

  return {
    definitions: [...proxyDefs, ...dotDefs],
    handlers,
    toolHintsById,
  };
}

// ============================================
// HELPERS
// ============================================

function mergeInto(target: Map<string, ToolHandler>, source: Map<string, ToolHandler>): void {
  for (const [id, handler] of source) target.set(id, handler);
}

function buildCombinedHints(
  manifest: ToolManifestEntry[],
): Record<string, { mutating?: boolean; verification?: boolean }> {
  const hints: Record<string, { mutating?: boolean; verification?: boolean }> = {};

  // Forward explicit definition-level flags from the manifest.
  // Every tool should declare mutatingHint / verificationHint directly;
  // the fallback to readOnlyHint is kept only for third-party MCP tools
  // that may not have been updated yet.
  for (const t of manifest) {
    if (t.annotations?.mutatingHint !== undefined || t.annotations?.verificationHint !== undefined) {
      hints[t.id] = {
        mutating: t.annotations.mutatingHint,
        verification: t.annotations.verificationHint,
      };
    }
  }

  // Dot-native hints (from definitions — single source of truth)
  Object.assign(hints, getDotToolHints());

  return hints;
}
