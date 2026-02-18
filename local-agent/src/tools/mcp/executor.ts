/**
 * MCP Tool Executor
 *
 * Routes tools/call requests for tools with runtime: "mcp"
 * through the appropriate MCP server client.
 */

import { mcpManager } from "./manager.js";
import type { DotBotTool } from "../../memory/types.js";
import type { ToolExecResult } from "../_shared/types.js";

/**
 * Execute a tool on an MCP server.
 *
 * Called from tool-executor.ts when a tool has runtime: "mcp".
 * Routes the call to the correct MCP server based on tool.mcpServer.
 */
export async function executeMcpTool(
  toolId: string,
  tool: DotBotTool,
  args: Record<string, any>,
): Promise<ToolExecResult> {
  const serverName = tool.mcpServer;
  if (!serverName) {
    return { success: false, output: "", error: `Tool ${toolId} has runtime "mcp" but no mcpServer field` };
  }

  const client = mcpManager.getClient(serverName);
  if (!client) {
    return { success: false, output: "", error: `MCP server "${serverName}" is not connected` };
  }

  if (!client.connected) {
    return { success: false, output: "", error: `MCP server "${serverName}" is disconnected` };
  }

  try {
    // Extract the original MCP tool name from the dotted ID: mcp.<server>.<name>
    const mcpToolName = toolId.split(".").slice(2).join(".");

    const result = await client.callTool(mcpToolName, args);

    // Convert MCP content array to a string output
    const output = formatMcpContent(result.content);

    return {
      success: !result.isError,
      output,
      error: result.isError ? output : undefined,
    };
  } catch (err) {
    return {
      success: false,
      output: "",
      error: `MCP call failed for ${toolId}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Convert MCP content items to a string representation.
 * MCP tools return an array of content items (text, image, resource, etc.).
 */
export function formatMcpContent(content: unknown[]): string {
  if (!Array.isArray(content) || content.length === 0) return "(no output)";

  const parts: string[] = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null) {
      parts.push(String(item));
      continue;
    }

    const typed = item as Record<string, unknown>;
    switch (typed.type) {
      case "text":
        parts.push(String(typed.text || ""));
        break;
      case "image":
        parts.push(`[image: ${typed.mimeType || "unknown"}]`);
        break;
      case "resource":
        if (typeof typed.resource === "object" && typed.resource !== null) {
          const res = typed.resource as Record<string, unknown>;
          parts.push(String(res.text || `[resource: ${res.uri}]`));
        }
        break;
      default:
        parts.push(JSON.stringify(typed));
    }
  }

  const output = parts.join("\n");
  return output.length > 8000 ? output.substring(0, 8000) + "\n...[truncated]" : output;
}
