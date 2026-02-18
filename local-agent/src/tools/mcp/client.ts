/**
 * MCP Client Wrapper
 *
 * Wraps the @modelcontextprotocol/sdk Client to connect/disconnect
 * to a single MCP server. Handles transport creation based on config.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { MCPServerConfig } from "./types.js";
import { resolveEnvRecord } from "./loader.js";

/** Tool as returned by the MCP SDK's listTools(). */
export interface MCPDiscoveredTool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, object>;
    required?: string[];
    [key: string]: unknown;
  };
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/** Callback invoked when the transport disconnects unexpectedly. */
export type OnDisconnectCallback = (serverName: string) => void;

/**
 * Manages a single MCP server connection.
 */
export class MCPServerClient {
  private client: Client;
  private transport: Transport | null = null;
  private _connected = false;
  private _onDisconnect: OnDisconnectCallback | null = null;

  constructor(
    public readonly config: MCPServerConfig,
  ) {
    this.client = new Client(
      { name: "dotbot", version: "1.0.0" },
      { capabilities: {} },
    );
  }

  /** Create the appropriate transport for this server's config. */
  private createTransport(): Transport {
    const { config } = this;

    switch (config.transport) {
      case "streamable-http": {
        const requestInit: RequestInit = {};
        if (config.headers) {
          requestInit.headers = resolveEnvRecord(config.headers);
        }
        return new StreamableHTTPClientTransport(
          new URL(config.url!),
          { requestInit },
        );
      }

      case "sse": {
        const requestInit: RequestInit = {};
        if (config.headers) {
          requestInit.headers = resolveEnvRecord(config.headers);
        }
        return new SSEClientTransport(
          new URL(config.url!),
          { requestInit },
        );
      }

      case "stdio": {
        return new StdioClientTransport({
          command: config.command!,
          args: config.args,
          env: config.env ? resolveEnvRecord(config.env) : undefined,
          cwd: config.cwd,
          stderr: "pipe",
        });
      }

      default:
        throw new Error(`Unsupported transport: ${config.transport}`);
    }
  }

  /** Connect to the MCP server. */
  async connect(): Promise<void> {
    if (this._connected) return;

    this.transport = this.createTransport();

    this.transport.onerror = (err) => {
      console.error(`[MCP:${this.config.name}] Transport error:`, err.message);
    };

    this.transport.onclose = () => {
      const wasConnected = this._connected;
      this._connected = false;
      console.log(`[MCP:${this.config.name}] Disconnected`);
      if (wasConnected && this._onDisconnect) {
        this._onDisconnect(this.config.name);
      }
    };

    await this.client.connect(this.transport);
    this._connected = true;
    console.log(`[MCP:${this.config.name}] Connected via ${this.config.transport}`);
  }

  /** Disconnect from the MCP server. */
  async disconnect(): Promise<void> {
    if (!this._connected) return;
    try {
      await this.client.close();
    } catch (err) {
      console.warn(`[MCP:${this.config.name}] Error during disconnect:`, err instanceof Error ? err.message : err);
    }
    this._connected = false;
    this.transport = null;
  }

  /** List tools available on this MCP server. */
  async listTools(): Promise<MCPDiscoveredTool[]> {
    if (!this._connected) throw new Error(`MCP server "${this.config.name}" is not connected`);
    const result = await this.client.listTools();
    return result.tools as MCPDiscoveredTool[];
  }

  /** Call a tool on this MCP server. */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: unknown[]; isError?: boolean }> {
    if (!this._connected) throw new Error(`MCP server "${this.config.name}" is not connected`);
    const result = await this.client.callTool({ name, arguments: args });
    return {
      content: (result as any).content ?? [],
      isError: (result as any).isError,
    };
  }

  get connected(): boolean {
    return this._connected;
  }

  get serverName(): string {
    return this.config.name;
  }

  /** Register a callback for unexpected disconnects. */
  set onDisconnect(cb: OnDisconnectCallback | null) {
    this._onDisconnect = cb;
  }
}
