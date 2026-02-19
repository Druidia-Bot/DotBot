/**
 * MCP Gateway — Server-Side Barrel Exports
 *
 * The server-side MCP gateway connects to credentialed MCP servers
 * on behalf of the local agent. Credentials are decrypted server-side
 * and never exist in plaintext on the client.
 *
 * Flow:
 *   1. Local agent reads ~/.bot/mcp/*.json, sends credentialed configs + encrypted blobs via WS
 *   2. Server decrypts blobs, connects to MCP servers, discovers tools
 *   3. Discovered tools are merged into the tool manifest as server-side handlers
 *   4. Tool execution goes through the server's live MCP connection
 */

export { initMcpForDevice, shutdownMcpForDevice, getMcpManifestEntries, executeMcpTool, hasMcpTools, getMcpConnectionStatus } from "./manager.js";
export { storeMcpBlobs, clearMcpBlobs } from "./vault-bridge.js";
export type { MCPServerConfig, MCPDiscoveredTool } from "./types.js";
