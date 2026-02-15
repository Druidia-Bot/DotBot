/**
 * Dot Tools — Barrel Export + Builder
 *
 * Re-exports all Dot-specific tool definitions and handlers,
 * and provides the buildDotTools() builder that assembles
 * Dot's complete tool set from proxy + server-side + Dot-specific.
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

import {
  TASK_DISPATCH_TOOL_ID,
  taskDispatchDefinition,
  taskDispatchHandler,
} from "./dispatch.js";

import {
  SKILL_SEARCH_TOOL_ID,
  skillSearchDefinition,
  skillSearchHandler,
  SKILL_READ_TOOL_ID,
  skillReadDefinition,
  skillReadHandler,
  SKILL_CREATE_TOOL_ID,
  skillCreateDefinition,
  skillCreateHandler,
  SKILL_DELETE_TOOL_ID,
  skillDeleteDefinition,
  skillDeleteHandler,
} from "./skills.js";

import {
  IDENTITY_READ_TOOL_ID,
  identityReadDefinition,
  identityReadHandler,
  IDENTITY_UPDATE_TOOL_ID,
  identityUpdateDefinition,
  identityUpdateHandler,
  IDENTITY_REMOVE_TOOL_ID,
  identityRemoveDefinition,
  identityRemoveHandler,
} from "./identity.js";

// Re-export everything for external consumers
export {
  TASK_DISPATCH_TOOL_ID,
  taskDispatchDefinition,
  taskDispatchHandler,
} from "./dispatch.js";

export {
  SKILL_SEARCH_TOOL_ID,
  skillSearchDefinition,
  skillSearchHandler,
  SKILL_READ_TOOL_ID,
  skillReadDefinition,
  skillReadHandler,
  SKILL_CREATE_TOOL_ID,
  skillCreateDefinition,
  skillCreateHandler,
  SKILL_DELETE_TOOL_ID,
  skillDeleteDefinition,
  skillDeleteHandler,
} from "./skills.js";

export {
  IDENTITY_READ_TOOL_ID,
  identityReadDefinition,
  identityReadHandler,
  IDENTITY_UPDATE_TOOL_ID,
  identityUpdateDefinition,
  identityUpdateHandler,
  IDENTITY_REMOVE_TOOL_ID,
  identityRemoveDefinition,
  identityRemoveHandler,
} from "./identity.js";

// ============================================
// BUILDER
// ============================================

/** Merge all entries from source into target (source wins on conflict). */
function mergeInto(target: Map<string, ToolHandler>, source: Map<string, ToolHandler>): void {
  for (const [id, handler] of source) target.set(id, handler);
}

export interface DotToolSetup {
  /** Native tool definitions for the LLM API. */
  definitions: ToolDefinition[];
  /** Handler map (toolId → handler). */
  handlers: Map<string, ToolHandler>;
}

/**
 * Build Dot's complete tool set.
 *
 * Layers:
 *   1. Proxy handlers for allowed categories (filesystem, shell, search, etc.)
 *   2. Server-side handlers (memory.*, knowledge.*)
 *   3. Dot-specific tools (task.dispatch, skill.*)
 */
export function buildDotTools(
  manifest: ToolManifestEntry[],
  onDispatch: (prompt: string) => Promise<{
    agentId?: string;
    workspacePath?: string;
    success?: boolean;
    executionResponse?: string;
  }>,
): DotToolSetup {
  // Filter manifest to Dot-allowed categories
  const dotManifest = manifest.filter(t => {
    const category = t.category || t.id.split(".")[0] || "";
    return DOT_PROXY_CATEGORIES.has(category);
  });

  // Layer 1: proxy handlers for filtered manifest
  const handlers = buildProxyHandlers(dotManifest);

  // Layer 2: server-side handlers (memory, knowledge)
  mergeInto(handlers, buildServerSideHandlers(dotManifest));

  // Layer 3: Dot-specific tools
  handlers.set(TASK_DISPATCH_TOOL_ID, taskDispatchHandler(onDispatch));
  handlers.set(SKILL_SEARCH_TOOL_ID, skillSearchHandler());
  handlers.set(SKILL_READ_TOOL_ID, skillReadHandler());
  handlers.set(SKILL_CREATE_TOOL_ID, skillCreateHandler());
  handlers.set(SKILL_DELETE_TOOL_ID, skillDeleteHandler());
  handlers.set(IDENTITY_READ_TOOL_ID, identityReadHandler());
  handlers.set(IDENTITY_UPDATE_TOOL_ID, identityUpdateHandler());
  handlers.set(IDENTITY_REMOVE_TOOL_ID, identityRemoveHandler());

  // Build native tool definitions
  const proxyDefs = manifestToNativeTools(dotManifest) || [];
  const dotDefs: ToolDefinition[] = [
    taskDispatchDefinition(),
    skillSearchDefinition(),
    skillReadDefinition(),
    skillCreateDefinition(),
    skillDeleteDefinition(),
    identityReadDefinition(),
    identityUpdateDefinition(),
    identityRemoveDefinition(),
  ];

  return {
    definitions: [...proxyDefs, ...dotDefs],
    handlers,
  };
}
