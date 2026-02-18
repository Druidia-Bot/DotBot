/**
 * MCP Server Configuration Types
 *
 * Defines the config schema for ~/.bot/mcp/*.json files.
 * One JSON file per MCP server.
 */

/** Supported MCP transport types. */
export type MCPTransportType = "streamable-http" | "stdio" | "sse";

/**
 * Configuration for a single MCP server.
 * Stored as ~/.bot/mcp/<name>.json
 */
export interface MCPServerConfig {
  /** Unique name for this server (used as prefix for tool IDs). */
  name: string;

  /** Transport protocol to use. */
  transport: MCPTransportType;

  /** Server URL — required for "streamable-http" and "sse" transports. */
  url?: string;

  /** HTTP headers for remote transports. Supports ${ENV_VAR} substitution. */
  headers?: Record<string, string>;

  /** Command to spawn — required for "stdio" transport. */
  command?: string;

  /** Arguments for the stdio command. */
  args?: string[];

  /** Environment variables for the stdio process. Supports ${ENV_VAR} substitution. */
  env?: Record<string, string>;

  /** Working directory for the stdio process. */
  cwd?: string;

  /**
   * Vault credential name. If set, the tool manifest will indicate
   * this credential must be configured. The ${VAR} in headers/env
   * resolves from process.env at connect time.
   */
  credentialRequired?: string;

  /** Whether this server is enabled. Defaults to true. */
  enabled?: boolean;
}

/** Runtime state for a connected MCP server. */
export interface MCPServerState {
  config: MCPServerConfig;
  status: "connecting" | "connected" | "disconnected" | "error";
  error?: string;
  toolCount: number;
}
