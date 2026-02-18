/**
 * MCP Integration — Barrel Exports + Entry Point
 *
 * Provides initMcpServers() for startup and shutdownMcpServers() for cleanup.
 * Called from registry.ts during tool initialization.
 */

export { loadMcpConfigs } from "./loader.js";
export { MCPServerClient } from "./client.js";
export { mcpManager } from "./manager.js";
export { executeMcpTool } from "./executor.js";
export type { MCPServerConfig, MCPServerState, MCPTransportType } from "./types.js";

import { loadMcpConfigs } from "./loader.js";
import { mcpManager } from "./manager.js";

/**
 * Initialize MCP servers: load configs, connect, discover and register tools.
 * Called from initToolRegistry() after core/custom/api tools are loaded.
 * Non-blocking — server connection failures are logged but don't break startup.
 */
export async function initMcpServers(): Promise<void> {
  try {
    const configs = await loadMcpConfigs();
    if (configs.length === 0) {
      console.log("[MCP] No MCP server configs found in ~/.bot/mcp/");
      return;
    }
    await mcpManager.init(configs);
  } catch (err) {
    console.error("[MCP] Failed to initialize MCP servers:", err instanceof Error ? err.message : err);
  }
}

/**
 * Gracefully disconnect all MCP servers.
 * Called during agent shutdown.
 */
export async function shutdownMcpServers(): Promise<void> {
  await mcpManager.shutdown();
}
