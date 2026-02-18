/**
 * Server-Side Tool Handlers — Unified Registry
 *
 * Single authority for ALL tools that bypass the local agent proxy.
 * Every non-proxy handler is registered here so builder functions
 * have one place to look.
 *
 * Two kinds of server-side handlers:
 *
 *   STATIC — always registered, same implementation regardless of manifest:
 *     - memory.*      — model CRUD via WebSocket memory bridge
 *     - knowledge.*   — vector search, file read/delete, ingestion
 *
 *   DYNAMIC — registered only when the manifest contains matching categories,
 *   delegating to callbacks stored in ctx.state:
 *     - premium       — paid API tools
 *     - imagegen      — image generation
 *     - schedule      — recurring tasks
 *     - research      — research artifacts
 *     - knowledge.ingest (overrides the static handler when ctx.state callback exists)
 */

import { createComponentLogger } from "#logging.js";
import type { ToolHandler, ToolContext } from "../types.js";
import type { ToolManifestEntry } from "#tools/types.js";

// Static handler imports — memory
import { handleMemorySaveMessage } from "./memory-save-message.js";
import { handleMemoryGetModelField } from "./memory-get-model-field.js";
import { handleMemoryGetModelDetail } from "./memory-get-model-detail.js";
import { handleMemoryCreateModel } from "./memory-create-model.js";
import { handleMemorySearch } from "./memory-search.js";
import { handleMemoryGetModelSpine } from "./memory-get-model-spine.js";

// Static handler imports — knowledge
import { handleKnowledgeSearch } from "./knowledge-search.js";
import { handleKnowledgeList } from "./knowledge-list.js";
import { handleKnowledgeRead } from "./knowledge-read.js";
import { handleKnowledgeDelete } from "./knowledge-delete.js";
import { handleKnowledgeIngest } from "./knowledge-ingest.js";

// Static handler imports — search (server-side, xAI Responses API)
import { handleGrokWebSearch, handleGrokXSearch, handleUnifiedWebSearch } from "./grok-search.js";

const log = createComponentLogger("tool-loop.server-handlers");

// ============================================
// STATIC HANDLERS (always registered)
// ============================================

const MEMORY_HANDLERS: [string, ToolHandler][] = [
  ["memory.save_message", handleMemorySaveMessage],
  ["memory.get_model_spine", handleMemoryGetModelSpine],
  ["memory.get_model_field", handleMemoryGetModelField],
  ["memory.get_model_detail", handleMemoryGetModelDetail],
  ["memory.create_model", handleMemoryCreateModel],
  ["memory.search", handleMemorySearch],
];

const KNOWLEDGE_HANDLERS: [string, ToolHandler][] = [
  ["knowledge.search", handleKnowledgeSearch],
  ["knowledge.list", handleKnowledgeList],
  ["knowledge.read", handleKnowledgeRead],
  ["knowledge.delete", handleKnowledgeDelete],
  ["knowledge.ingest", handleKnowledgeIngest],
];

const SEARCH_HANDLERS: [string, ToolHandler][] = [
  ["search.grok_web", handleGrokWebSearch],
  ["search.grok_x", handleGrokXSearch],
  ["search.web", handleUnifiedWebSearch],
];

// ============================================
// DYNAMIC HANDLERS (manifest-driven, ctx.state callbacks)
// ============================================

type ServerExecutor = (
  toolId: string,
  args: Record<string, any>,
  ...extra: any[]
) => Promise<{ success: boolean; output: string; error?: string }>;

/** Category → ctx.state key mapping for dynamic handlers. */
const DYNAMIC_CATEGORIES: Record<string, { stateKey: string; label: string }> = {
  premium:  { stateKey: "executePremiumTool",      label: "premium" },
  imagegen: { stateKey: "executeImageGenTool",     label: "imagegen" },
  schedule: { stateKey: "executeScheduleTool",     label: "schedule" },
};

function buildDynamicHandler(stateKey: string, label: string): ToolHandler {
  return async (ctx: ToolContext, args: Record<string, any>) => {
    const executor = ctx.state[stateKey] as ServerExecutor | undefined;
    if (!executor) {
      return `Error: ${label} executor not available`;
    }

    const toolId = ctx.state._currentToolId as string;
    log.info(`Routing to ${label} executor`, { toolId });

    const result = await executor(toolId, args);
    if (!result.success) {
      throw new Error(result.error || `${label} tool failed`);
    }
    return result.output;
  };
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Build the complete server-side handler map.
 *
 * Always includes memory + knowledge handlers.
 * Conditionally adds dynamic handlers (premium, imagegen, schedule, research)
 * based on which categories appear in the manifest.
 *
 * This is the single source of truth for all non-proxy handlers.
 */
export function buildServerSideHandlers(
  manifest: ToolManifestEntry[],
): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  // Static: always registered
  for (const [id, handler] of MEMORY_HANDLERS) {
    handlers.set(id, handler);
  }
  for (const [id, handler] of KNOWLEDGE_HANDLERS) {
    handlers.set(id, handler);
  }
  for (const [id, handler] of SEARCH_HANDLERS) {
    handlers.set(id, handler);
  }

  // Dynamic: registered per manifest category
  const dynamicHandlerCache = new Map<string, ToolHandler>();

  for (const entry of manifest) {
    const config = DYNAMIC_CATEGORIES[entry.category];
    if (!config) continue;

    if (!dynamicHandlerCache.has(entry.category)) {
      dynamicHandlerCache.set(entry.category, buildDynamicHandler(config.stateKey, config.label));
    }
    handlers.set(entry.id, dynamicHandlerCache.get(entry.category)!);
  }

  // knowledge.ingest override: when a ctx.state callback is provided,
  // the dynamic handler takes precedence over the static one
  if (manifest.some(t => t.id === "knowledge.ingest")) {
    handlers.set("knowledge.ingest", buildDynamicHandler("executeKnowledgeIngest", "knowledge ingest"));
  }

  log.info("Built server-side handlers", {
    static: MEMORY_HANDLERS.length + KNOWLEDGE_HANDLERS.length + SEARCH_HANDLERS.length,
    dynamic: dynamicHandlerCache.size,
    total: handlers.size,
  });

  return handlers;
}

/**
 * Convenience: memory handlers only.
 * Used by simple callers (receptionist tool loop) that don't need the full registry.
 */
export function getMemoryHandlers(): Map<string, ToolHandler> {
  return new Map<string, ToolHandler>(MEMORY_HANDLERS);
}

/**
 * Convenience: knowledge handlers only.
 */
export function getKnowledgeHandlers(): Map<string, ToolHandler> {
  return new Map<string, ToolHandler>(KNOWLEDGE_HANDLERS);
}
