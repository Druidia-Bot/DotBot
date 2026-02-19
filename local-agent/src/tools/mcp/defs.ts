/**
 * MCP Management Tool Definitions
 *
 * Tools for setting up and managing MCP server connections.
 */

import type { DotBotTool } from "../../memory/types.js";

export const mcpManagementTools: DotBotTool[] = [
  {
    id: "mcp.setup_server",
    name: "setup_server",
    description: "Create or update an MCP server configuration. Writes a config file to ~/.bot/mcp/<name>.json. If the server requires authentication, specify credentialRequired with the vault key name (the credential must already exist in the vault). A restart is required after setup for the connection to activate.",
    source: "core",
    category: "mcp",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Unique server name (lowercase, no spaces). Used as prefix for discovered tool IDs (e.g., 'lobsterbands' → mcp.lobsterbands.*)." },
        transport: { type: "string", enum: ["sse", "streamable-http", "stdio"], description: "Transport protocol. Use 'sse' for most remote MCP servers." },
        url: { type: "string", description: "Server URL — required for 'sse' and 'streamable-http' transports." },
        command: { type: "string", description: "Command to spawn — required for 'stdio' transport." },
        args: { type: "array", items: { type: "string" }, description: "Arguments for the stdio command (optional)." },
        credentialRequired: { type: "string", description: "Vault credential name if the server requires authentication (e.g., 'LOBSTERBANDS_API_TOKEN'). Must already exist in the vault." },
        enabled: { type: "boolean", description: "Whether the server is enabled. Defaults to true." },
      },
      required: ["name", "transport"],
    },
    annotations: { mutatingHint: true },
  },
  {
    id: "mcp.list_servers",
    name: "list_servers",
    description: "List all configured MCP servers and their connection status.",
    source: "core",
    category: "mcp",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: { readOnlyHint: true, mutatingHint: false },
  },
  {
    id: "mcp.remove_server",
    name: "remove_server",
    description: "Remove an MCP server configuration. Deletes the config file and disconnects the server if connected. A restart may be needed to fully clean up.",
    source: "core",
    category: "mcp",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Server name to remove." },
      },
      required: ["name"],
    },
    annotations: { destructiveHint: true, mutatingHint: true },
  },
];
