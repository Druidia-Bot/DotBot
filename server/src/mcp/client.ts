/**
 * MCP Client — Server-Side
 *
 * Wraps the @modelcontextprotocol/sdk Client for a single MCP server.
 * Unlike the local-agent client, this one can inject decrypted vault
 * credentials into transport headers — plaintext never leaves the server.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { MCPServerConfig, MCPDiscoveredTool } from "./types.js";

/** Callback invoked when the transport disconnects unexpectedly. */
export type OnDisconnectCallback = (serverName: string) => void;

/**
 * Manages a single MCP server connection on the server side.
 * Credentials are injected as plaintext headers — safe because
 * this code runs on the server, never on the client.
 */
export class ServerMCPClient {
  private client: Client;
  private transport: Transport | null = null;
  private _connected = false;
  private _onDisconnect: OnDisconnectCallback | null = null;

  constructor(
    public readonly config: MCPServerConfig,
    private readonly decryptedToken: string | null,
  ) {
    this.client = new Client(
      { name: "dotbot-server", version: "1.0.0" },
      { capabilities: {} },
    );
  }

  private createTransport(): Transport {
    const { config } = this;

    // Build headers with decrypted credential injected
    const headers: Record<string, string> = { ...(config.headers || {}) };
    if (this.decryptedToken) {
      headers["Authorization"] = `Bearer ${this.decryptedToken}`;
    }

    switch (config.transport) {
      case "streamable-http":
        return new StreamableHTTPClientTransport(
          new URL(config.url!),
          { requestInit: { headers } },
        );

      case "sse":
        return new SSEClientTransport(
          new URL(config.url!),
          { requestInit: { headers } },
        );

      default:
        throw new Error(`Server MCP gateway only supports http/sse transports, got: ${config.transport}`);
    }
  }

  async connect(): Promise<void> {
    if (this._connected) return;

    this.transport = this.createTransport();

    this.transport.onerror = (err) => {
      console.error(`[MCP-GW:${this.config.name}] Transport error:`, err.message);
    };

    this.transport.onclose = () => {
      const wasConnected = this._connected;
      this._connected = false;
      if (wasConnected && this._onDisconnect) {
        this._onDisconnect(this.config.name);
      }
    };

    // Race against a timeout — some MCP servers hang on connect
    const CONNECT_TIMEOUT_MS = 30_000;
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Connection timed out after ${CONNECT_TIMEOUT_MS / 1000}s`)), CONNECT_TIMEOUT_MS),
    );

    console.log(`[MCP-GW:${this.config.name}] Connecting via ${this.config.transport}...`);
    await Promise.race([this.client.connect(this.transport), timeout]);
    this._connected = true;
    console.log(`[MCP-GW:${this.config.name}] Connected`);
  }

  async disconnect(): Promise<void> {
    if (!this._connected) return;
    try {
      await this.client.close();
    } catch {
      // Swallow — best-effort cleanup
    }
    this._connected = false;
    this.transport = null;
  }

  async listTools(): Promise<MCPDiscoveredTool[]> {
    if (!this._connected) throw new Error(`MCP server "${this.config.name}" is not connected`);
    const result = await this.client.listTools();
    return result.tools as MCPDiscoveredTool[];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: unknown[]; isError?: boolean }> {
    if (!this._connected) throw new Error(`MCP server "${this.config.name}" is not connected`);
    const result = await this.client.callTool({ name, arguments: args });
    return {
      content: (result as any).content ?? [],
      isError: (result as any).isError,
    };
  }

  get connected(): boolean { return this._connected; }
  get serverName(): string { return this.config.name; }

  set onDisconnect(cb: OnDisconnectCallback | null) {
    this._onDisconnect = cb;
  }
}
