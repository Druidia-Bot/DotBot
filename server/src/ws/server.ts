/**
 * WebSocket Server
 *
 * Slim orchestrator — creates the WSS, wires schedulers, and routes messages.
 *
 * Directory layout:
 * - bridge/       — request/response bridge to local agent (commands, results, notifications)
 * - handlers/     — message type handlers (auth, admin, prompt, heartbeat, condenser, llm)
 * - lifecycle/    — server lifecycle hooks (post-auth tasks, scheduler wiring)
 * - devices.ts    — shared device state + send helpers
 */

import { WebSocketServer, WebSocket } from "ws";
import { nanoid } from "nanoid";
import type {
  WSMessage,
  WSAuthMessage,
  WSPromptMessage,
  WSRegisterDeviceMessage,
} from "../types.js";
import { initServerPersonas } from "../personas/loader.js";
import { initDatabase } from "../db/index.js";
import { createComponentLogger } from "#logging.js";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

// State
import {
  devices,
  sendMessage,
  sendError,
  rejectAllPending,
  hasAnyConnectedDevices,
} from "./devices.js";

// Bridge — result handlers (called when local agent sends responses)
import {
  handleExecutionResult,
  handleMemoryResult,
  handleSkillResult,
  handlePersonaResult,
  handleCouncilResult,
  handleKnowledgeResult,
  handleKnowledgeQueryResult,
  handleSchemaResult,
  handleToolResult,
} from "./bridge/results.js";

// Handlers — message type processors
import { handleRegisterDevice, handleAuth } from "./handlers/auth.js";
import { handleAdminRequest } from "./handlers/admin.js";
import { handlePrompt, cleanupUserSession } from "./handlers/prompt.js";
import { handleHeartbeatRequest } from "./handlers/heartbeat.js";
import { handleCondenseRequest, handleResolveLoopRequest } from "./handlers/condenser.js";
import { handleFormatFixRequest, handleLLMCallRequest } from "./handlers/llm.js";
import {
  handleCredentialSessionRequest,
  handleCredentialProxyRequest,
  handleCredentialResolveRequest,
  cleanupResolveTracking,
} from "../credentials/handlers/index.js";

// Lifecycle
import { wireSchedulers } from "./lifecycle/scheduler.js";

// MCP Gateway
import { initMcpForDevice, storeMcpBlobs, clearMcpBlobs } from "../mcp/index.js";

// Re-export for backwards compatibility
export {
  getConnectedDevices,
  disconnectDevice,
  broadcastToUser,
  getDeviceForUser,
  type MemoryRequest,
  type SkillRequest,
} from "./devices.js";
export {
  sendExecutionCommand,
  sendMemoryRequest,
  sendSkillRequest,
  requestPersonas,
  requestCouncilPaths,
  requestKnowledge,
  requestKnowledgeQuery,
} from "./device-bridge.js";

const log = createComponentLogger("ws");

// Server version — read from VERSION file at repo root
const SERVER_VERSION = (() => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const candidates = [
    path.resolve(__dirname, "..", "..", "VERSION"),       // dist/ws → repo root
    path.resolve(__dirname, "..", "..", "..", "VERSION"),  // deeper nesting
  ];
  for (const p of candidates) {
    try {
      const ver = readFileSync(p, "utf-8").trim();
      console.log(`[ws] SERVER_VERSION=${ver} (from ${p})`);
      return ver;
    } catch {}
  }
  console.warn(`[ws] VERSION file not found — tried: ${candidates.join(", ")}`);
  return "unknown";
})();

// ============================================
// SERVER INITIALIZATION
// ============================================

/**
 * Initialize server-side components (personas, database).
 * MUST be called explicitly before creating the WebSocket server.
 * Moved from module-level side effects to enable proper test isolation.
 */
export function initWSServer(): void {
  initServerPersonas();
  initDatabase();
  log.info("WebSocket server components initialized");
}

// ============================================
// WEBSOCKET SERVER
// ============================================

export function createWSServer(options: {
  port: number;
  apiKey: string;
  provider?: "deepseek" | "anthropic" | "openai" | "gemini";
  httpBaseUrl?: string;
}): WebSocketServer {
  const wss = new WebSocketServer({ port: options.port });

  const provider = options.provider || "deepseek";
  const model = provider === "deepseek" ? "deepseek-chat"
    : provider === "anthropic" ? "claude-opus-4-6"
    : provider === "openai" ? "gpt-4o"
    : provider === "gemini" ? "gemini-3-pro-preview"
    : "deepseek-chat";

  log.info(`Server started on port ${options.port}`);

  // Wire scheduler task execution to the prompt pipeline
  wireSchedulers(options.apiKey, provider);

  // ── WS-level ping/pong (RFC 6455) — detect half-open connections ──
  const WS_PING_INTERVAL_MS = 30_000;
  const pingInterval = setInterval(() => {
    for (const client of wss.clients) {
      if ((client as any)._dotAlive === false) {
        log.info("Terminating dead WebSocket — no pong received");
        client.terminate();
        continue;
      }
      (client as any)._dotAlive = false;
      client.ping();
    }
  }, WS_PING_INTERVAL_MS);
  wss.on("close", () => clearInterval(pingInterval));

  // ── Connection handler ──

  wss.on("connection", (ws) => {
    let deviceId: string | null = null;
    let connectionKey: string | null = null;

    // Mark alive on connect and on every pong frame
    (ws as any)._dotAlive = true;
    ws.on("pong", () => { (ws as any)._dotAlive = true; });

    log.debug("New connection");

    ws.on("message", async (data) => {
      try {
        const message: WSMessage = JSON.parse(data.toString());

        if (connectionKey) {
          const dev = devices.get(connectionKey);
          if (dev) dev.session.lastActiveAt = new Date();
        }

        switch (message.type) {
          case "register_device":
            if (deviceId) { sendError(ws, "Already authenticated"); break; }
            connectionKey = handleRegisterDevice(ws, message as WSRegisterDeviceMessage, provider, model);
            deviceId = connectionKey;
            break;
          case "auth":
            if (deviceId) { sendError(ws, "Already authenticated"); break; }
            connectionKey = handleAuth(ws, message as WSAuthMessage, provider, model, SERVER_VERSION);
            deviceId = connectionKey?.replace(/:browser$/, '') || null;
            break;
          case "prompt":
            if (!deviceId) { sendError(ws, "Not authenticated"); return; }
            await handlePrompt(deviceId, message as WSPromptMessage, options.apiKey, provider, ws);
            break;
          case "execution_result":
            if (deviceId) handleExecutionResult(deviceId, message.payload);
            break;
          case "schema_result":
            if (deviceId) handleSchemaResult(deviceId, message.payload);
            break;
          case "memory_result":
            if (deviceId) handleMemoryResult(deviceId, message.payload);
            break;
          case "skill_result":
            if (deviceId) handleSkillResult(deviceId, message.payload);
            break;
          case "persona_result":
            if (deviceId) handlePersonaResult(deviceId, message.payload);
            break;
          case "council_result":
            if (deviceId) handleCouncilResult(deviceId, message.payload);
            break;
          case "knowledge_result":
            if (deviceId) handleKnowledgeResult(deviceId, message.payload);
            break;
          case "knowledge_query_result":
            if (deviceId) handleKnowledgeQueryResult(deviceId, message.payload);
            break;
          case "tool_result":
            if (deviceId) handleToolResult(deviceId, message.payload);
            break;
          case "condense_request":
            if (deviceId) await handleCondenseRequest(deviceId, message);
            break;
          case "resolve_loop_request":
            if (deviceId) await handleResolveLoopRequest(deviceId, message);
            break;
          case "format_fix_request":
            if (deviceId) await handleFormatFixRequest(deviceId, message);
            break;
          case "heartbeat_request":
            if (deviceId) await handleHeartbeatRequest(deviceId, message);
            break;
          case "llm_call_request":
            if (deviceId) await handleLLMCallRequest(deviceId, message);
            break;
          case "credential_session_request":
            if (deviceId) handleCredentialSessionRequest(deviceId, message, options.httpBaseUrl || `http://localhost:3000`);
            break;
          case "credential_proxy_request":
            if (deviceId) await handleCredentialProxyRequest(deviceId, message);
            break;
          case "credential_resolve_request":
            if (deviceId) await handleCredentialResolveRequest(deviceId, message);
            break;
          case "cancel_before_restart":
            if (deviceId) {
              log.info("Cancel before restart: V2 uses session-based agents, no cancellation needed", { deviceId });
              sendMessage(ws, {
                type: "cancel_before_restart_ack",
                id: nanoid(),
                timestamp: Date.now(),
                payload: { cancelled: 0, prompts: [] },
              });
            }
            break;
          case "admin_request":
            if (deviceId) handleAdminRequest(deviceId, message);
            break;
          case "mcp_configs":
            if (deviceId) {
              const device = devices.get(deviceId);
              if (device) {
                const { configs, credentialBlobs } = message.payload;
                if (credentialBlobs) storeMcpBlobs(deviceId, credentialBlobs);
                initMcpForDevice(deviceId, device.session.userId, configs).catch(err => {
                  log.error("MCP gateway init failed", err instanceof Error ? err : new Error(String(err)), { deviceId });
                });
              }
            }
            break;
          case "ping":
            sendMessage(ws, { type: "pong", id: nanoid(), timestamp: Date.now(), payload: {} });
            break;
        }
      } catch (error) {
        log.error("Message error", { error });
        sendError(ws, "Invalid message format");
      }
    });

    ws.on("close", () => handleClose(ws, connectionKey, deviceId));

    ws.on("error", (error) => {
      log.error("WebSocket error", { error });
    });
  });

  return wss;
}

// ============================================
// CLOSE HANDLER
// ============================================

function handleClose(ws: WebSocket, connectionKey: string | null, deviceId: string | null): void {
  if (!connectionKey) return;

  const device = devices.get(connectionKey);

  // Only act if THIS WebSocket is still the current one for this connection.
  // If the agent reconnected, devices.get(connectionKey) returns the NEW connection
  // and we must NOT mark it disconnected or cancel its tasks.
  if (!device || device.ws !== ws) {
    if (device) {
      log.debug(`Stale WS closed for ${connectionKey} — device already reconnected, ignoring`);
    }
    return;
  }

  const userId = device.session.userId;
  device.session.status = "disconnected";
  log.info(`Device disconnected: ${device.session.deviceName}`);

  // Reject all pending requests so awaiting callers don't hang forever
  rejectAllPending(device, new Error("Device disconnected"));

  const isLocalAgent = device.session.capabilities?.includes("memory");
  if (isLocalAgent) {
    log.info("Local-agent disconnect: rejected pending requests", { deviceId });
  }
  if (deviceId) {
    cleanupResolveTracking(deviceId);
    // NOTE: Do NOT shutdownMcpForDevice here — a late WS close event can race
    // with a fresh initMcpForDevice from a reconnecting agent, killing the new
    // MCP connections. initMcpForDevice already calls shutdown at the top.
    // Blobs are cleared so they're re-sent on reconnect.
    clearMcpBlobs(deviceId);
  }

  // Clean up V2 orchestrator state if this was the user's last device
  if (!hasAnyConnectedDevices(userId)) {
    log.info("User's last device disconnected — cleaning up V2 session state", { userId });
    cleanupUserSession(userId);
  }
}
