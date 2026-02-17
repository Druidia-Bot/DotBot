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

import {
  BACKSTORY_GENERATE_TOOL_ID,
  backstoryGenerateDefinition,
  backstoryGenerateHandler,
} from "./backstory.js";

import {
  LOGS_LIST_TOOL_ID,
  logsListDefinition,
  logsListHandler,
  LOGS_READ_TOOL_ID,
  logsReadDefinition,
  logsReadHandler,
  LOGS_SEARCH_TOOL_ID,
  logsSearchDefinition,
  logsSearchHandler,
} from "./logs.js";

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

export {
  BACKSTORY_GENERATE_TOOL_ID,
  backstoryGenerateDefinition,
  backstoryGenerateHandler,
} from "./backstory.js";

export {
  LOGS_LIST_TOOL_ID,
  logsListDefinition,
  logsListHandler,
  LOGS_READ_TOOL_ID,
  logsReadDefinition,
  logsReadHandler,
  LOGS_SEARCH_TOOL_ID,
  logsSearchDefinition,
  logsSearchHandler,
} from "./logs.js";

// ============================================
// BUILDER
// ============================================

/** Merge all entries from source into target (source wins on conflict). */
function mergeInto(target: Map<string, ToolHandler>, source: Map<string, ToolHandler>): void {
  for (const [id, handler] of source) target.set(id, handler);
}

function buildToolHintsById(manifest: ToolManifestEntry[]): Record<string, { mutating?: boolean; verification?: boolean }> {
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

  // Dot-native tools (not in the manifest)
  hints[TASK_DISPATCH_TOOL_ID] = { mutating: true, verification: false };
  hints[SKILL_SEARCH_TOOL_ID] = { mutating: false, verification: true };
  hints[SKILL_READ_TOOL_ID] = { mutating: false, verification: true };
  hints[SKILL_CREATE_TOOL_ID] = { mutating: true, verification: false };
  hints[SKILL_DELETE_TOOL_ID] = { mutating: true, verification: false };
  hints[IDENTITY_READ_TOOL_ID] = { mutating: false, verification: true };
  hints[IDENTITY_UPDATE_TOOL_ID] = { mutating: true, verification: false };
  hints[IDENTITY_REMOVE_TOOL_ID] = { mutating: true, verification: false };
  hints[BACKSTORY_GENERATE_TOOL_ID] = { mutating: true, verification: false };
  hints[LOGS_LIST_TOOL_ID] = { mutating: false, verification: true };
  hints[LOGS_READ_TOOL_ID] = { mutating: false, verification: true };
  hints[LOGS_SEARCH_TOOL_ID] = { mutating: false, verification: true };
  hints[TOOL_EXECUTE_ID] = { mutating: true, verification: false };

  return hints;
}

export interface DotToolSetup {
  /** Native tool definitions for the LLM API. */
  definitions: ToolDefinition[];
  /** Handler map (toolId → handler). */
  handlers: Map<string, ToolHandler>;
  /** Behavior hints for Dot verification loop keyed by tool ID. */
  toolHintsById: Record<string, { mutating?: boolean; verification?: boolean }>;
}

/**
 * Build Dot's complete tool set.
 *
 * Handlers are registered for ALL tools in the manifest so Dot can
 * call anything. Only a curated subset of definitions is sent to the
 * LLM to keep the context window small. Dot discovers additional
 * tools via `tools.list_tools` and calls them through `tools.execute`.
 *
 * Layers:
 *   1. Proxy handlers for the FULL manifest (every tool callable)
 *   2. Server-side handlers (memory.*, knowledge.*)
 *   3. Dot-specific tools (task.dispatch, skill.*, identity.*)
 *   4. tools.execute — generic passthrough for any tool by ID
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
  // Curated categories whose definitions are sent to the LLM
  const dotManifest = manifest.filter(t => {
    const category = t.category || t.id.split(".")[0] || "";
    return DOT_PROXY_CATEGORIES.has(category);
  });

  // Layer 1: proxy handlers for the FULL manifest (Dot can call anything)
  const handlers = buildProxyHandlers(manifest);

  // Layer 2: server-side handlers (memory, knowledge) — full manifest
  mergeInto(handlers, buildServerSideHandlers(manifest));

  // Layer 3: Dot-specific tools
  handlers.set(TASK_DISPATCH_TOOL_ID, taskDispatchHandler(onDispatch));
  handlers.set(SKILL_SEARCH_TOOL_ID, skillSearchHandler());
  handlers.set(SKILL_READ_TOOL_ID, skillReadHandler());
  handlers.set(SKILL_CREATE_TOOL_ID, skillCreateHandler());
  handlers.set(SKILL_DELETE_TOOL_ID, skillDeleteHandler());
  handlers.set(IDENTITY_READ_TOOL_ID, identityReadHandler());
  handlers.set(IDENTITY_UPDATE_TOOL_ID, identityUpdateHandler());
  handlers.set(IDENTITY_REMOVE_TOOL_ID, identityRemoveHandler());
  handlers.set(BACKSTORY_GENERATE_TOOL_ID, backstoryGenerateHandler());
  handlers.set(LOGS_LIST_TOOL_ID, logsListHandler());
  handlers.set(LOGS_READ_TOOL_ID, logsReadHandler());
  handlers.set(LOGS_SEARCH_TOOL_ID, logsSearchHandler());

  // Layer 4: tools.execute — generic passthrough for discovered tools
  handlers.set(TOOL_EXECUTE_ID, toolExecuteHandler(handlers));

  // Build native tool definitions — only curated categories + Dot-specific
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
    backstoryGenerateDefinition(),
    logsListDefinition(),
    logsReadDefinition(),
    logsSearchDefinition(),
    toolExecuteDefinition(),
  ];

  const toolHintsById = buildToolHintsById(dotManifest);

  return {
    definitions: [...proxyDefs, ...dotDefs],
    handlers,
    toolHintsById,
  };
}

// ============================================
// TOOLS.EXECUTE — Generic passthrough
// ============================================

const TOOL_EXECUTE_ID = "tools.execute";

function toolExecuteDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: "tools__execute",
      description:
        "Execute any tool by its ID. Use this to call tools you discovered via tools.list_tools " +
        "that aren't in your primary tool set. Pass the exact tool ID and its arguments.",
      parameters: {
        type: "object",
        properties: {
          tool_id: {
            type: "string",
            description: "The exact tool ID to execute (e.g. 'discord.full_setup', 'onboarding.status')",
          },
          args: {
            type: "object",
            description: "Arguments to pass to the tool (varies per tool)",
          },
        },
        required: ["tool_id"],
      },
    },
  };
}

function toolExecuteHandler(allHandlers: Map<string, ToolHandler>): ToolHandler {
  return async (ctx, args) => {
    const toolId = args.tool_id;
    if (!toolId || typeof toolId !== "string") {
      return "Error: tool_id is required";
    }

    const handler = allHandlers.get(toolId);
    if (!handler) {
      return `Error: Unknown tool '${toolId}'. Use tools.list_tools to see available tools.`;
    }

    const toolArgs = args.args || {};
    return handler(ctx, toolArgs);
  };
}
