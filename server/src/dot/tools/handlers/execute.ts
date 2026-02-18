/**
 * Handler: tools.execute
 *
 * Generic passthrough that lets Dot call any tool by ID.
 * Closure-based — receives the complete handler map at build time.
 */

import type { ToolHandler } from "#tool-loop/types.js";

export function toolExecuteHandler(allHandlers: Map<string, ToolHandler>): ToolHandler {
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
