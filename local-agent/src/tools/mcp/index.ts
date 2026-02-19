/**
 * MCP Integration — Barrel Exports + Entry Point
 *
 * Provides initMcpServers() for startup and shutdownMcpServers() for cleanup.
 * Called from registry.ts during tool initialization.
 *
 * Split behavior:
 * - Non-credentialed servers (stdio, local): connected here on the local agent
 * - Credentialed servers (need vault tokens): configs sent to server via WS,
 *   server connects and exposes tools as server-side handlers
 */

export { loadMcpConfigs } from "./loader.js";
export { MCPServerClient } from "./client.js";
export { mcpManager } from "./manager.js";
export { executeMcpTool } from "./executor.js";
export type { MCPServerConfig, MCPServerState, MCPTransportType } from "./types.js";

import { loadMcpConfigs } from "./loader.js";
import { mcpManager } from "./manager.js";
import type { MCPServerConfig } from "./types.js";

/** Configs that need server-side handling (credentialed). Persisted across reconnects. */
let serverSideConfigs: MCPServerConfig[] = [];

/**
 * Initialize MCP servers: load configs, connect local-only servers,
 * and stash credentialed configs for delivery to the server.
 * Called from initToolRegistry() after core/custom/api tools are loaded.
 */
export async function initMcpServers(): Promise<void> {
  try {
    const configs = await loadMcpConfigs();
    if (configs.length === 0) {
      console.log("[MCP] No MCP server configs found in ~/.bot/mcp/");
      return;
    }

    // Split: credentialed servers go to the server, the rest connect locally
    const localConfigs: MCPServerConfig[] = [];
    const serverConfigs: MCPServerConfig[] = [];

    for (const config of configs) {
      if (config.credentialRequired) {
        serverConfigs.push(config);
      } else {
        localConfigs.push(config);
      }
    }

    if (localConfigs.length > 0) {
      await mcpManager.init(localConfigs);
    }

    if (serverConfigs.length > 0) {
      serverSideConfigs = serverConfigs;
      console.log(`[MCP] ${serverConfigs.length} credentialed server(s) queued for server-side handling`);
    }
  } catch (err) {
    console.error("[MCP] Failed to initialize MCP servers:", err instanceof Error ? err.message : err);
  }
}

/**
 * Get credentialed MCP configs that need to be sent to the server.
 * Called after WS authentication succeeds. Returns configs on EVERY call
 * so they're re-sent on WS reconnect (server clears blobs on disconnect).
 */
export function getServerSideConfigs(): MCPServerConfig[] {
  return serverSideConfigs;
}

/**
 * Gracefully disconnect all local MCP servers.
 * Called during agent shutdown.
 */
export async function shutdownMcpServers(): Promise<void> {
  await mcpManager.shutdown();
}
