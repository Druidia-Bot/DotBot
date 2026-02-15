/**
 * Tool Handler — Local Agent Proxy
 *
 * Catch-all handler that forwards tool calls to the local agent via
 * WebSocket. Any tool not handled by a server-side handler gets
 * proxied here.
 *
 * Features:
 *   - Category-aware timeouts (codegen 11min, shell 5min, etc.)
 *   - Destructive tool sandboxing (from manifest annotations)
 *   - Confirmation requirements (from manifest annotations)
 *   - Result truncation for oversized output
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "#logging.js";
import { sendExecutionCommand } from "#ws/device-bridge.js";
import type { ToolHandler, ToolContext } from "../types.js";
import type { ToolManifestEntry } from "#tools/types.js";

const log = createComponentLogger("tool-loop.proxy");

/** Max characters per tool result before truncation. */
const MAX_TOOL_RESULT_CHARS = 8_000;

/** Category-aware timeouts. Unlisted categories get 30s default. */
const TIMEOUT_BY_CATEGORY: Record<string, number> = {
  codegen: 660_000,   // 11 min (codegen's internal timeout is 10 min)
  secrets: 960_000,   // 16 min (credential entry blocks up to 15 min)
  shell: 300_000,     // 5 min
  market: 180_000,    // 3 min
  browser: 60_000,    // 1 min
  gui: 60_000,        // 1 min
};
const DEFAULT_TIMEOUT = 30_000;

/**
 * Create a proxy handler for a specific tool, using its manifest entry
 * for timeout, sandboxing, and approval settings.
 */
function createProxyHandler(entry: ToolManifestEntry): ToolHandler {
  const toolId = entry.id;
  const category = entry.category || toolId.split(".")[0] || "";
  const timeout = TIMEOUT_BY_CATEGORY[category] || DEFAULT_TIMEOUT;
  const sandboxed = entry.annotations?.destructiveHint ?? false;
  const requiresApproval = entry.annotations?.requiresConfirmation ?? false;

  return async (ctx: ToolContext, args: Record<string, any>): Promise<string> => {
    const commandId = `proxy_${nanoid(8)}`;

    // Store current toolId so server-side handlers can read it
    ctx.state._currentToolId = toolId;

    try {
      const output = await sendExecutionCommand(ctx.deviceId, {
        id: commandId,
        type: "tool_execute",
        payload: { toolId, toolArgs: args },
        dryRun: false,
        timeout,
        sandboxed,
        requiresApproval,
      });

      return truncateResult(output || "(no output)");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn("Local agent tool failed", { toolId, commandId, error: errMsg });
      throw err;
    }
  };
}

/**
 * Build a handler map with proxy entries for every tool in the manifest.
 * Server-side handlers (memory, knowledge, premium, etc.) should be
 * merged on top of this map so they take priority over proxying.
 */
export function buildProxyHandlers(
  manifest: ToolManifestEntry[],
): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  for (const entry of manifest) {
    handlers.set(entry.id, createProxyHandler(entry));
  }
  return handlers;
}

function truncateResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) return result;
  return (
    result.substring(0, MAX_TOOL_RESULT_CHARS) +
    `\n\n...[truncated — original was ${result.length} chars. Summarize what you have.]`
  );
}
