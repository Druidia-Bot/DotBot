/**
 * Handler: tools.execute
 *
 * Generic passthrough that lets Dot call any tool by ID.
 * Closure-based — receives the complete handler map at build time.
 *
 * Falls back to the local-agent proxy for tools not in the pre-built
 * handler map (e.g., tools saved via tools.save_tool during this
 * conversation — they exist in the local registry but weren't in the
 * manifest when handlers were built).
 */

import { nanoid } from "nanoid";
import { sendExecutionCommand } from "#ws/device-bridge.js";
import type { ToolHandler } from "#tool-loop/types.js";

export function toolExecuteHandler(allHandlers: Map<string, ToolHandler>): ToolHandler {
  return async (ctx, args) => {
    const toolId = args.tool_id;
    if (!toolId || typeof toolId !== "string") {
      return "Error: tool_id is required";
    }

    const toolArgs = args.args || {};

    // Try pre-built handler first (covers all manifest tools + server-side tools)
    const handler = allHandlers.get(toolId);
    if (handler) {
      return handler(ctx, toolArgs);
    }

    // Fallback: proxy directly to the local agent. This handles tools
    // registered mid-conversation (e.g., via tools.save_tool) that weren't
    // in the manifest when the handler map was built.
    try {
      const output = await sendExecutionCommand(ctx.deviceId, {
        id: `exec_${nanoid(8)}`,
        type: "tool_execute",
        payload: { toolId, toolArgs },
        dryRun: false,
        timeout: 30_000,
        sandboxed: false,
        requiresApproval: false,
      });
      return output || "(no output)";
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return `Error executing '${toolId}': ${errMsg}`;
    }
  };
}
