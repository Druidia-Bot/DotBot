/**
 * MCP Server Manager
 *
 * Manages the lifecycle of multiple MCP server connections.
 * Discovers tools from each server and registers them in DotBot's tool registry.
 */

import { MCPServerClient } from "./client.js";
import { registerTool, unregisterTool } from "../registry.js";
import type { MCPServerConfig, MCPServerState } from "./types.js";
import type { DotBotTool } from "../../memory/types.js";

/** Singleton manager for all MCP server connections. */
const RECONNECT_DELAY_MS = 5_000;

class MCPManager {
  private clients = new Map<string, MCPServerClient>();
  /** Track which tool IDs belong to which server, for cleanup on disconnect. */
  private serverToolIds = new Map<string, string[]>();
  /** Prevent concurrent reconnect attempts for the same server. */
  private reconnecting = new Set<string>();

  /**
   * Connect to all configured MCP servers and discover their tools.
   */
  async init(configs: MCPServerConfig[]): Promise<void> {
    if (configs.length === 0) return;

    console.log(`[MCP] Initializing ${configs.length} MCP server(s)...`);

    const results = await Promise.allSettled(
      configs.map(config => this.connectServer(config)),
    );

    let connected = 0;
    for (const result of results) {
      if (result.status === "fulfilled") connected++;
    }
    console.log(`[MCP] ${connected}/${configs.length} server(s) connected`);
  }

  /** Connect to a single MCP server and register its tools. */
  private async connectServer(config: MCPServerConfig): Promise<void> {
    const client = new MCPServerClient(config);

    try {
      await client.connect();
      this.clients.set(config.name, client);

      // Handle unexpected disconnects: unregister stale tools, attempt reconnect
      client.onDisconnect = (serverName) => this.handleDisconnect(serverName);

      // Discover and register tools
      const toolIds = await this.discoverTools(client);
      this.serverToolIds.set(config.name, toolIds);

      console.log(`[MCP:${config.name}] Registered ${toolIds.length} tool(s)`);
    } catch (err) {
      console.error(`[MCP:${config.name}] Connection failed:`, err instanceof Error ? err.message : err);
    }
  }

  /** Discover tools from an MCP server and register them in the DotBot registry. */
  private async discoverTools(client: MCPServerClient): Promise<string[]> {
    const mcpTools = await client.listTools();
    const registeredIds: string[] = [];

    for (const mcpTool of mcpTools) {
      // Build a DotBot-compatible tool ID: mcp.<server>.<toolname>
      const toolId = `mcp.${client.serverName}.${mcpTool.name}`;

      const dotbotTool: DotBotTool = {
        id: toolId,
        name: mcpTool.name,
        title: mcpTool.annotations?.title,
        description: mcpTool.description || `MCP tool from ${client.serverName}`,
        inputSchema: mcpTool.inputSchema,
        source: "mcp",
        category: `mcp.${client.serverName}`,
        executor: "local",
        runtime: "mcp",
        mcpServer: client.serverName,
        annotations: mcpTool.annotations ? {
          readOnlyHint: mcpTool.annotations.readOnlyHint,
          destructiveHint: mcpTool.annotations.destructiveHint,
        } : undefined,
      };

      // Propagate credential requirement from server config to each tool
      if (client.config.credentialRequired) {
        dotbotTool.credentialRequired = client.config.credentialRequired;
      }

      registerTool(dotbotTool);
      registeredIds.push(toolId);
    }

    return registeredIds;
  }

  /** Get a connected MCP client by server name. */
  getClient(serverName: string): MCPServerClient | undefined {
    return this.clients.get(serverName);
  }

  /** Get status of all MCP servers. */
  getStatus(): MCPServerState[] {
    const states: MCPServerState[] = [];
    for (const [name, client] of this.clients) {
      states.push({
        config: client.config,
        status: client.connected ? "connected" : "disconnected",
        toolCount: this.serverToolIds.get(name)?.length ?? 0,
      });
    }
    return states;
  }

  /** Disconnect all MCP servers and unregister their tools. */
  async shutdown(): Promise<void> {
    for (const [name, client] of this.clients) {
      // Unregister tools
      const toolIds = this.serverToolIds.get(name) || [];
      for (const id of toolIds) {
        unregisterTool(id);
      }

      // Disconnect
      await client.disconnect();
    }

    this.clients.clear();
    this.serverToolIds.clear();
    console.log("[MCP] All servers disconnected");
  }

  /** Handle unexpected disconnect: unregister stale tools, attempt single reconnect. */
  private handleDisconnect(serverName: string): void {
    // Immediately unregister stale tools so Dot doesn't try to call them
    const toolIds = this.serverToolIds.get(serverName) || [];
    for (const id of toolIds) unregisterTool(id);
    this.serverToolIds.delete(serverName);
    console.warn(`[MCP:${serverName}] Unregistered ${toolIds.length} stale tool(s) after disconnect`);

    // Attempt a single reconnect after a delay
    if (this.reconnecting.has(serverName)) return;
    const client = this.clients.get(serverName);
    if (!client) return;

    this.reconnecting.add(serverName);
    console.log(`[MCP:${serverName}] Will attempt reconnect in ${RECONNECT_DELAY_MS / 1000}s...`);

    setTimeout(async () => {
      try {
        await this.connectServer(client.config);
        console.log(`[MCP:${serverName}] Reconnected successfully`);
      } catch (err) {
        console.error(`[MCP:${serverName}] Reconnect failed:`, err instanceof Error ? err.message : err);
      } finally {
        this.reconnecting.delete(serverName);
      }
    }, RECONNECT_DELAY_MS);
  }

  /** Reconnect a specific server (e.g., after config change). */
  async reconnectServer(serverName: string, config: MCPServerConfig): Promise<void> {
    // Clean up existing connection
    const existing = this.clients.get(serverName);
    if (existing) {
      const toolIds = this.serverToolIds.get(serverName) || [];
      for (const id of toolIds) unregisterTool(id);
      await existing.disconnect();
      this.clients.delete(serverName);
      this.serverToolIds.delete(serverName);
    }

    // Reconnect
    await this.connectServer(config);
  }
}

/** Singleton instance. */
export const mcpManager = new MCPManager();
