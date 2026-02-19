/**
 * MCP Gateway Manager — Server-Side
 *
 * Manages all credentialed MCP server connections. Connects using
 * decrypted vault credentials, discovers tools, and exposes them
 * for server-side execution.
 *
 * Lifecycle:
 *   1. Local agent sends mcp_configs via WS after auth
 *   2. Manager decrypts credentials, connects to each MCP server
 *   3. Discovered tools are registered and available for tool loops
 *   4. On device disconnect, all connections for that device are torn down
 */

import { createComponentLogger } from "#logging.js";
import { ServerMCPClient } from "./client.js";
import { vaultDecryptForMcp } from "./vault-bridge.js";
import type { MCPServerConfig, MCPDiscoveredTool } from "./types.js";
import type { ToolManifestEntry } from "#tools/types.js";

const log = createComponentLogger("mcp-gateway");

const RECONNECT_DELAY_MS = 5_000;

/**
 * Per-device MCP state. Each connected device can have its own set
 * of MCP servers (configs come from that device's ~/.bot/mcp/).
 */
interface DeviceMCPState {
  clients: Map<string, ServerMCPClient>;
  tools: Map<string, { serverName: string; tool: MCPDiscoveredTool }>;
  reconnecting: Set<string>;
  errors: Map<string, string>;
  /** Incremented on each init — stale disconnect handlers check this to bail out. */
  generation: number;
}

const deviceStates = new Map<string, DeviceMCPState>();

/**
 * Pending debounced init — coalesces rapid `initMcpForDevice` calls.
 * When the agent reconnects its WS several times in quick succession,
 * each reconnect re-sends mcp_configs. Without debouncing, every call
 * shuts down the previous mid-connection, wasting retries. The debounce
 * ensures only the LAST call within the window actually executes.
 */
const pendingInits = new Map<string, {
  timer: ReturnType<typeof setTimeout>;
  userId: string;
  configs: MCPServerConfig[];
}>();

const INIT_DEBOUNCE_MS = 3_000;

// ============================================
// PUBLIC API
// ============================================

/**
 * Initialize MCP connections for a device.
 * Called when the server receives mcp_configs from the local agent.
 *
 * Debounced: if called again for the same device within 3s, the
 * previous pending init is cancelled and only the latest one runs.
 */
export async function initMcpForDevice(
  deviceId: string,
  userId: string,
  configs: MCPServerConfig[],
): Promise<void> {
  // Cancel any pending debounced init for this device
  const pending = pendingInits.get(deviceId);
  if (pending) {
    clearTimeout(pending.timer);
    log.info("MCP init debounced — superseded by newer mcp_configs", { deviceId });
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingInits.delete(deviceId);
      doInitMcpForDevice(deviceId, userId, configs).then(resolve, reject);
    }, INIT_DEBOUNCE_MS);

    pendingInits.set(deviceId, { timer, userId, configs });
  });
}

/**
 * Actual init — runs after the debounce window closes.
 */
async function doInitMcpForDevice(
  deviceId: string,
  userId: string,
  configs: MCPServerConfig[],
): Promise<void> {
  // Clean up any existing state for this device
  await shutdownMcpForDevice(deviceId);

  const state: DeviceMCPState = {
    clients: new Map(),
    tools: new Map(),
    reconnecting: new Set(),
    errors: new Map(),
    generation: 0,
  };
  deviceStates.set(deviceId, state);

  log.info("Initializing MCP gateway", { deviceId, serverCount: configs.length });

  const results = await Promise.allSettled(
    configs.map(config => connectServer(deviceId, userId, state, config)),
  );

  const succeeded = results.filter(r => r.status === "fulfilled").length;
  const failed = results.filter(r => r.status === "rejected").length;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "rejected") {
      const err = r.reason instanceof Error ? r.reason : new Error(String(r.reason));
      log.error("MCP server connection failed", err, {
        serverName: configs[i].name,
      });
    }
  }

  log.info("MCP gateway initialized", { deviceId, succeeded, failed, totalTools: state.tools.size });
}

/**
 * Shut down all MCP connections for a device.
 * Called on device disconnect or before re-init.
 */
export async function shutdownMcpForDevice(deviceId: string): Promise<void> {
  // Cancel any pending debounced init so it doesn't fire after shutdown
  const pending = pendingInits.get(deviceId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingInits.delete(deviceId);
  }

  const state = deviceStates.get(deviceId);
  if (!state) return;

  // Bump generation so any in-flight disconnect handlers from these clients are ignored
  state.generation++;

  // Detach disconnect handlers BEFORE disconnecting to prevent stale events
  for (const client of state.clients.values()) {
    client.onDisconnect = null;
  }

  for (const client of state.clients.values()) {
    try {
      await client.disconnect();
    } catch {
      // Best-effort cleanup
    }
  }

  state.clients.clear();
  state.tools.clear();
  state.reconnecting.clear();
  state.errors.clear();
  deviceStates.delete(deviceId);

  log.info("MCP gateway shut down", { deviceId });
}

/**
 * Get all MCP tool manifest entries for a device.
 * These get merged into the tool manifest alongside local-agent tools.
 */
export function getMcpManifestEntries(deviceId: string): ToolManifestEntry[] {
  const state = deviceStates.get(deviceId);
  if (!state) return [];

  const entries: ToolManifestEntry[] = [];
  for (const [toolId, { serverName, tool }] of state.tools) {
    entries.push({
      id: toolId,
      name: toolId.replace(/\./g, "__"),
      description: tool.description || `MCP tool from ${serverName}`,
      category: `mcp.${serverName}`,
      inputSchema: {
        type: tool.inputSchema?.type || "object",
        properties: (tool.inputSchema?.properties as Record<string, any>) || {},
        required: tool.inputSchema?.required || [],
      },
      annotations: {
        readOnlyHint: tool.annotations?.readOnlyHint,
        mutatingHint: !tool.annotations?.readOnlyHint,
        destructiveHint: tool.annotations?.destructiveHint,
      },
    });
  }

  return entries;
}

/**
 * Execute an MCP tool call for a device.
 * Returns the formatted result string.
 */
export async function executeMcpTool(
  deviceId: string,
  toolId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const state = deviceStates.get(deviceId);
  if (!state) throw new Error(`No MCP state for device ${deviceId}`);

  const entry = state.tools.get(toolId);
  if (!entry) throw new Error(`MCP tool "${toolId}" not found`);

  const client = state.clients.get(entry.serverName);
  if (!client?.connected) throw new Error(`MCP server "${entry.serverName}" is not connected`);

  // Extract the raw tool name (strip mcp.<server>. prefix)
  const rawToolName = entry.tool.name;

  const result = await client.callTool(rawToolName, args);

  if (result.isError) {
    const errorText = formatMcpContent(result.content);
    throw new Error(`MCP tool error: ${errorText}`);
  }

  return formatMcpContent(result.content);
}

/**
 * Check if a device has any MCP tools registered.
 */
export function hasMcpTools(deviceId: string): boolean {
  const state = deviceStates.get(deviceId);
  return !!state && state.tools.size > 0;
}

/**
 * Get connection status for all MCP servers for a device.
 * Includes error messages for failed connections.
 */
export function getMcpConnectionStatus(deviceId: string): { name: string; connected: boolean; toolCount: number; error?: string }[] {
  const state = deviceStates.get(deviceId);
  if (!state) return [];

  const statuses: { name: string; connected: boolean; toolCount: number; error?: string }[] = [];
  const seen = new Set<string>();

  for (const [name, client] of state.clients) {
    seen.add(name);
    const toolCount = [...state.tools.values()].filter(t => t.serverName === name).length;
    const error = state.errors.get(name);
    statuses.push({ name, connected: client.connected, toolCount, ...(error && { error }) });
  }

  // Include servers that failed to connect (no client entry)
  for (const [name, error] of state.errors) {
    if (!seen.has(name)) {
      statuses.push({ name, connected: false, toolCount: 0, error });
    }
  }

  return statuses;
}

// ============================================
// INTERNAL
// ============================================

const MAX_CONNECT_RETRIES = 2;
const RETRY_DELAY_MS = 3_000;

async function connectServer(
  deviceId: string,
  userId: string,
  state: DeviceMCPState,
  config: MCPServerConfig,
): Promise<void> {
  // Decrypt credential if needed
  let decryptedToken: string | null = null;
  if (config.credentialRequired) {
    decryptedToken = await vaultDecryptForMcp(userId, config.credentialRequired, deviceId);
    if (!decryptedToken) {
      const msg = `Credential "${config.credentialRequired}" not available in vault`;
      log.warn("Skipping MCP server — credential not available", {
        serverName: config.name,
        credential: config.credentialRequired,
      });
      state.errors.set(config.name, msg);
      return;
    }
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_CONNECT_RETRIES; attempt++) {
    if (attempt > 0) {
      log.info("Retrying MCP connection", { serverName: config.name, attempt, deviceId });
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }

    // Check generation — bail if state was replaced during retry wait
    if (!deviceStates.has(deviceId) || deviceStates.get(deviceId) !== state) return;

    const client = new ServerMCPClient(config, decryptedToken);

    // Wire disconnect handler — capture generation to detect stale events
    const gen = state.generation;
    client.onDisconnect = (serverName) => {
      if (state.generation !== gen) return; // stale — state was replaced
      handleDisconnect(deviceId, userId, state, serverName);
    };

    try {
      await client.connect();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      log.warn("MCP connection attempt failed", {
        serverName: config.name, attempt, error: lastError.message, deviceId,
      });
      try { await client.disconnect(); } catch { /* best-effort */ }
      continue;
    }

    state.clients.set(config.name, client);
    state.errors.delete(config.name);
    log.info("MCP server connected", { serverName: config.name, deviceId });

    // Discover tools
    try {
      const tools = await client.listTools();
      for (const tool of tools) {
        const toolId = `mcp.${config.name}.${tool.name}`;
        state.tools.set(toolId, { serverName: config.name, tool });
      }
      log.info("MCP tools discovered", { serverName: config.name, toolCount: tools.length, deviceId });
      return; // success
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      log.warn("MCP tool discovery failed", {
        serverName: config.name, attempt, error: lastError.message, deviceId,
      });
      try { await client.disconnect(); } catch { /* best-effort */ }
      state.clients.delete(config.name);
      continue;
    }
  }

  // All retries exhausted
  const msg = `Connection failed after ${MAX_CONNECT_RETRIES + 1} attempts: ${lastError?.message}`;
  state.errors.set(config.name, msg);
  throw new Error(msg);
}

function handleDisconnect(
  deviceId: string,
  userId: string,
  state: DeviceMCPState,
  serverName: string,
): void {
  // Remove stale tools
  const staleIds: string[] = [];
  for (const [toolId, entry] of state.tools) {
    if (entry.serverName === serverName) staleIds.push(toolId);
  }
  for (const id of staleIds) state.tools.delete(id);

  log.warn("MCP server disconnected — removed tools", {
    serverName, removedTools: staleIds.length, deviceId,
  });

  // Single reconnect attempt
  if (state.reconnecting.has(serverName)) return;
  const client = state.clients.get(serverName);
  if (!client) return;

  state.reconnecting.add(serverName);
  log.info("Will attempt MCP reconnect", { serverName, delayMs: RECONNECT_DELAY_MS });

  setTimeout(async () => {
    try {
      await connectServer(deviceId, userId, state, client.config);
      log.info("MCP reconnected", { serverName });
    } catch (err) {
      log.error("MCP reconnect failed", err instanceof Error ? err : new Error(String(err)), {
        serverName,
      });
    } finally {
      state.reconnecting.delete(serverName);
    }
  }, RECONNECT_DELAY_MS);
}

// ============================================
// CONTENT FORMATTING
// ============================================

const MAX_OUTPUT_LENGTH = 8_000;

function formatMcpContent(content: unknown[]): string {
  if (!Array.isArray(content) || content.length === 0) return "(no output)";

  const parts: string[] = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null) {
      parts.push(String(item));
      continue;
    }
    const obj = item as Record<string, any>;
    switch (obj.type) {
      case "text":
        parts.push(obj.text ?? "");
        break;
      case "image":
        parts.push(`[image: ${obj.mimeType || "unknown"}]`);
        break;
      case "resource":
        parts.push(obj.resource?.text ?? `[resource: ${obj.resource?.uri || "unknown"}]`);
        break;
      default:
        parts.push(JSON.stringify(obj));
    }
  }

  let output = parts.join("\n");
  if (output.length > MAX_OUTPUT_LENGTH) {
    output = output.substring(0, MAX_OUTPUT_LENGTH) + "...[truncated]";
  }
  return output;
}
