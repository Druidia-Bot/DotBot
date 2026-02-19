/**
 * MCP Gateway Types — Server-Side
 *
 * Config types match the local-agent's MCPServerConfig shape
 * so configs can be sent over WS without transformation.
 */

/** Transport types supported by the MCP gateway. */
export type MCPTransportType = "streamable-http" | "sse" | "stdio";

/**
 * MCP server configuration — received from the local agent.
 * Only credentialed configs (those with credentialRequired) are sent here.
 * The credential NAME is safe to transmit — the server decrypts the blob internally.
 */
export interface MCPServerConfig {
  name: string;
  transport: MCPTransportType;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  credentialRequired?: string;
  enabled?: boolean;
}

/** A tool discovered from an MCP server. */
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
