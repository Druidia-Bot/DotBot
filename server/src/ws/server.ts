/**
 * WebSocket Server
 * 
 * Core server setup, authentication, and message routing.
 * 
 * Separated concerns:
 * - prompt-handler.ts — orchestrator logic for user prompts
 * - context-builder.ts — fetches memory, history, tools, personas for each prompt
 * - runner-factory.ts — creates configured AgentRunner instances
 * - device-bridge.ts — request/response bridge to local agent
 * - condenser-handlers.ts — sleep cycle condense/resolve handlers
 */

import { WebSocketServer, WebSocket } from "ws";
import { nanoid } from "nanoid";
import type {
  WSMessage,
  WSAuthMessage,
  WSPromptMessage,
  WSRegisterDeviceMessage,
  DeviceSession,
} from "../types.js";
import { initServerPersonas } from "../personas/loader.js";
import { initDatabase } from "../db/index.js";
import { createComponentLogger } from "../logging.js";

// Extracted modules
import {
  devices,
  sendMessage,
  sendError,
  getDeviceForUser,
  broadcastToUser,
  notifyAdminDevices,
} from "./devices.js";
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
} from "./device-bridge.js";
import {
  handleCondenseRequest,
  handleResolveLoopRequest,
  handleFormatFixRequest,
  handleLLMCallRequest,
} from "./condenser-handlers.js";
import { handleHeartbeatRequest } from "./heartbeat-handler.js";
import { handleAdminRequest } from "./admin-handler.js";
import { handleCredentialSessionRequest, handleCredentialProxyRequest, handleCredentialResolveRequest, cleanupResolveTracking } from "../credentials/handlers.js";
import { handlePrompt } from "./prompt-handler.js";
import { cancelAllTasksForRestart, cancelAllTasksForRestartByUser, cancelAllTasksForUser } from "../agents/agent-tasks.js";
import { setExecuteCallback, onSchedulerEvent } from "../scheduler/index.js";
import type { DeferredTask } from "../scheduler/index.js";
import { validateAndConsumeToken } from "../auth/invite-tokens.js";
import { registerDevice, authenticateDevice, getRecentFailures, logAuthEvent, listDevices } from "../auth/device-store.js";
import { getWebAuthToken } from "../init.js";

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

// Server configuration (set by createWSServer)
let serverProvider: string = "unknown";
let serverModel: string = "unknown";

// Initialize server-side components
initServerPersonas();
initDatabase();

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
  
  serverProvider = options.provider || "deepseek";
  serverModel = serverProvider === "deepseek" ? "deepseek-chat" 
    : serverProvider === "anthropic" ? "claude-opus-4-6"
    : serverProvider === "openai" ? "gpt-4o"
    : serverProvider === "gemini" ? "gemini-3-pro-preview"
    : "deepseek-chat";
  
  log.info(`Server started on port ${options.port}`);

  // #5: Wire scheduler task execution — deferred tasks route through the prompt pipeline
  setExecuteCallback(async (task: DeferredTask) => {
    const deviceId = getDeviceForUser(task.userId);
    if (!deviceId) {
      throw new Error(`User ${task.userId} has no connected device — cannot execute deferred task`);
    }

    // Build a synthetic prompt message that carries the deferred task context
    const syntheticMessage = {
      type: "prompt" as const,
      id: `sched_${task.id}`,
      timestamp: Date.now(),
      payload: {
        prompt: `[Scheduled Task — ${task.deferReason}] ${task.originalPrompt}`,
        threadId: task.threadIds?.[0],
        source: "scheduler",
        taskId: task.id,
      },
    };

    log.info("Executing deferred task via prompt pipeline", {
      taskId: task.id,
      userId: task.userId,
      deviceId,
      prompt: task.originalPrompt.substring(0, 80),
    });

    await handlePrompt(deviceId, syntheticMessage as any, options.apiKey, serverProvider);
    return `Deferred task ${task.id} executed via prompt pipeline`;
  });

  // #5c: Route scheduler events to connected devices as notifications
  onSchedulerEvent((event) => {
    // Only notify on meaningful state changes
    if (!["task_completed", "task_failed", "task_expired"].includes(event.type)) return;

    const labels: Record<string, string> = {
      task_completed: "Scheduled task completed",
      task_failed: "Scheduled task failed",
      task_expired: "Scheduled task expired",
    };

    broadcastToUser(event.userId, {
      type: "user_notification",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        source: "scheduler",
        level: event.type === "task_completed" ? "info" : "warning",
        title: labels[event.type] || event.type,
        taskId: event.taskId,
        details: event.details,
      },
    });
  });

  wss.on("connection", (ws) => {
    let deviceId: string | null = null;
    
    log.debug("New connection");

    ws.on("message", async (data) => {
      try {
        const message: WSMessage = JSON.parse(data.toString());

        if (deviceId) {
          const dev = devices.get(deviceId);
          if (dev) dev.session.lastActiveAt = new Date();
        }
        
        switch (message.type) {
          case "register_device":
            if (deviceId) { sendError(ws, "Already authenticated"); break; }
            deviceId = handleRegisterDevice(ws, message as WSRegisterDeviceMessage);
            break;
          case "auth":
            if (deviceId) { sendError(ws, "Already authenticated"); break; }
            deviceId = handleAuth(ws, message as WSAuthMessage);
            break;
          case "prompt":
            if (!deviceId) { sendError(ws, "Not authenticated"); return; }
            await handlePrompt(deviceId, message as WSPromptMessage, options.apiKey, serverProvider);
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
            if (deviceId) await handleCondenseRequest(deviceId, message, options.apiKey, serverProvider);
            break;
          case "resolve_loop_request":
            if (deviceId) await handleResolveLoopRequest(deviceId, message, options.apiKey, serverProvider);
            break;
          case "format_fix_request":
            if (deviceId) await handleFormatFixRequest(deviceId, message, options.apiKey, serverProvider);
            break;
          case "heartbeat_request":
            if (deviceId) await handleHeartbeatRequest(deviceId, message, options.apiKey, serverProvider);
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
              // Use userId-based lookup so we cancel ALL tasks (including browser-spawned ones)
              const dev = devices.get(deviceId);
              const restartResult = dev
                ? cancelAllTasksForRestartByUser(dev.session.userId)
                : cancelAllTasksForRestart(deviceId);
              log.info(`Cancel before restart: cancelled ${restartResult.cancelled} task(s), ${restartResult.prompts.length} prompt(s) to re-queue`, { deviceId });
              sendMessage(ws, {
                type: "cancel_before_restart_ack",
                id: nanoid(),
                timestamp: Date.now(),
                payload: { cancelled: restartResult.cancelled, prompts: restartResult.prompts },
              });
            }
            break;
          case "admin_request":
            if (deviceId) handleAdminRequest(deviceId, message);
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

    ws.on("close", () => {
      if (deviceId) {
        const device = devices.get(deviceId);
        // Only act if THIS WebSocket is still the current one for this deviceId.
        // If the agent reconnected, devices.get(deviceId) returns the NEW connection
        // and we must NOT mark it disconnected or cancel its tasks.
        if (device && device.ws === ws) {
          device.session.status = "disconnected";
          log.info(`Device disconnected: ${device.session.deviceName}`);
          // Only cancel running tasks when a LOCAL AGENT disconnects (tools become unavailable).
          // Browser clients are just display — closing a tab should NOT cancel agent work.
          const isLocalAgent = device.session.capabilities?.includes("memory");
          if (isLocalAgent) {
            const cancelled = cancelAllTasksForUser(device.session.userId);
            if (cancelled > 0) {
              log.info(`Cancelled ${cancelled} task(s) on local-agent disconnect`, { deviceId });
            }
          }
          cleanupResolveTracking(deviceId);
        } else if (device) {
          log.debug(`Stale WS closed for ${deviceId} — device already reconnected, ignoring`);
        }
      }
    });

    ws.on("error", (error) => {
      log.error("WebSocket error", { error });
    });
  });

  return wss;
}

// ============================================
// DEVICE REGISTRATION HANDLER
// ============================================

function handleRegisterDevice(ws: WebSocket, message: WSRegisterDeviceMessage): string | null {
  const { inviteToken, label, hwFingerprint, capabilities, tempDir } = message.payload;

  if (!inviteToken || !hwFingerprint || !label) {
    sendMessage(ws, {
      type: "auth_failed",
      id: nanoid(),
      timestamp: Date.now(),
      payload: { reason: "missing_fields", message: "inviteToken and hwFingerprint are required" },
    });
    return null;
  }

  // Validate and consume the invite token
  const tokenResult = validateAndConsumeToken(inviteToken);
  if (!tokenResult.valid) {
    log.warn("Device registration failed: invalid invite token", { reason: tokenResult.reason });
    sendMessage(ws, {
      type: "auth_failed",
      id: nanoid(),
      timestamp: Date.now(),
      payload: { reason: tokenResult.reason, message: `Invite token rejected: ${tokenResult.reason}` },
    });
    return null;
  }

  // Register the device
  const ip = (ws as any)._socket?.remoteAddress || "unknown";
  const { deviceId, deviceSecret } = registerDevice({ label, hwFingerprint, ip });

  // Create session
  const session: DeviceSession = {
    id: nanoid(),
    userId: `user_${deviceId}`,
    deviceId,
    deviceName: label,
    capabilities,
    tempDir,
    connectedAt: new Date(),
    lastActiveAt: new Date(),
    status: "connected",
  };

  devices.set(deviceId, {
    ws,
    session,
    pendingCommands: new Map(),
    pendingMemoryRequests: new Map(),
    pendingSkillRequests: new Map(),
    pendingPersonaRequests: new Map(),
    pendingCouncilRequests: new Map(),
    pendingThreadRequests: new Map(),
    pendingKnowledgeRequests: new Map(),
    pendingToolRequests: new Map(),
  });

  log.info(`Device registered: ${label} (${deviceId})`);

  sendMessage(ws, {
    type: "device_registered",
    id: nanoid(),
    timestamp: Date.now(),
    payload: {
      deviceId,
      deviceSecret,
      sessionId: session.id,
      provider: serverProvider,
      model: serverModel,
      webAuthToken: getWebAuthToken() || undefined,
    },
  });

  return deviceId;
}

// ============================================
// AUTH HANDLER
// ============================================

function handleAuth(ws: WebSocket, message: WSAuthMessage): string | null {
  const { deviceId, deviceSecret, deviceName, capabilities, tempDir, hwFingerprint } = message.payload;

  const ip = (ws as any)._socket?.remoteAddress || "unknown";

  // Web clients authenticate with a web auth token (no device credentials).
  // These get capabilities: ['prompt'] only — no tool execution.
  // CRITICAL: Web clients must share the same userId as the local agent
  // so that getDeviceForUser() can find the local agent for tool execution.
  if (!deviceSecret || !hwFingerprint) {
    const expectedToken = getWebAuthToken();
    const providedToken = message.payload.webAuthToken;

    if (!expectedToken) {
      log.error("Web auth token not initialized — rejecting web client");
      sendMessage(ws, {
        type: "auth_failed",
        id: nanoid(),
        timestamp: Date.now(),
        payload: { reason: "server_misconfigured", message: "Server web auth token not configured" },
      });
      return null;
    }

    if (!providedToken || providedToken !== expectedToken) {
      log.warn("Web client auth failed: invalid web auth token", { ip });
      sendMessage(ws, {
        type: "auth_failed",
        id: nanoid(),
        timestamp: Date.now(),
        payload: { reason: "invalid_web_token", message: "Invalid web auth token. Check your server admin for the correct token." },
      });
      return null;
    }

    const webDeviceId = `web_${nanoid(8)}`;

    // Look up the primary registered device so browser shares its userId.
    // Without this, browser gets userId "user_web_<random>" which never
    // matches the local agent's "user_<deviceId>", making tools/memory
    // permanently unavailable from the browser.
    let userId = `user_${webDeviceId}`;
    try {
      const registeredDevices = listDevices().filter(d => d.status === "active");
      if (registeredDevices.length > 0) {
        userId = `user_${registeredDevices[0].deviceId}`;
        log.info(`Web client linked to registered device`, { webDeviceId, linkedTo: registeredDevices[0].deviceId });
      }
    } catch {
      log.warn("Could not look up registered devices for web client userId linkage");
    }

    const session: DeviceSession = {
      id: nanoid(),
      userId,
      deviceId: webDeviceId,
      deviceName: deviceName || "Web Browser",
      capabilities: capabilities || ["prompt"],
      tempDir,
      connectedAt: new Date(),
      lastActiveAt: new Date(),
      status: "connected",
    };

    devices.set(webDeviceId, {
      ws,
      session,
      pendingCommands: new Map(),
      pendingMemoryRequests: new Map(),
      pendingSkillRequests: new Map(),
      pendingPersonaRequests: new Map(),
      pendingCouncilRequests: new Map(),
      pendingThreadRequests: new Map(),
      pendingKnowledgeRequests: new Map(),
      pendingToolRequests: new Map(),
    });

    log.info(`Web client connected`, { webDeviceId, ip });

    sendMessage(ws, {
      type: "auth",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        success: true,
        sessionId: session.id,
        provider: serverProvider,
        model: serverModel,
      },
    });
    return webDeviceId;
  }

  if (!deviceId || !deviceSecret || !hwFingerprint) {
    sendMessage(ws, {
      type: "auth_failed",
      id: nanoid(),
      timestamp: Date.now(),
      payload: { reason: "missing_fields", message: "deviceId, deviceSecret, and hwFingerprint are required" },
    });
    return null;
  }

  // Rate limiting: 3 failures per IP within 15 minutes
  const recentFailures = getRecentFailures(ip, 15);
  if (recentFailures >= 3) {
    log.warn("SECURITY: Rate limit exceeded", { ip, recentFailures });
    logAuthEvent({ eventType: "auth_failure", deviceId, ip, reason: "rate_limited" });
    notifyAdminDevices({
      title: "🚨 Rate Limit Exceeded",
      message: `IP \`${ip}\` blocked after ${recentFailures} failed auth attempts in 15 minutes. Device ID: \`${deviceId}\``,
      level: "critical",
    });
    sendMessage(ws, {
      type: "auth_failed",
      id: nanoid(),
      timestamp: Date.now(),
      payload: { reason: "rate_limited", message: "Too many failed attempts. Try again later." },
    });
    return null;
  }

  const authResult = authenticateDevice({ deviceId, deviceSecret, hwFingerprint, ip });

  if (!authResult.success) {
    log.warn("Device auth failed", { deviceId, reason: authResult.reason, ip });

    // Security alert on fingerprint mismatch (device was revoked)
    if (authResult.reason === "fingerprint_mismatch") {
      notifyAdminDevices({
        title: "🚨 Hardware Fingerprint Mismatch",
        message: `Device \`${deviceId}\` attempted auth from IP \`${ip}\` with a different hardware fingerprint. **Device has been revoked.** This may indicate credential theft.`,
        level: "critical",
      });
    }

    sendMessage(ws, {
      type: "auth_failed",
      id: nanoid(),
      timestamp: Date.now(),
      payload: { reason: authResult.reason, message: `Authentication failed: ${authResult.reason}` },
    });
    return null;
  }

  // If this device was already connected (reconnect), close the old WS gracefully
  const existingDevice = devices.get(deviceId);
  if (existingDevice && existingDevice.ws !== ws) {
    log.info(`Device ${deviceId} reconnecting — closing stale WebSocket`);
    try { existingDevice.ws.close(); } catch { /* already closed */ }
  }

  const session: DeviceSession = {
    id: nanoid(),
    userId: `user_${deviceId}`,
    deviceId,
    deviceName: deviceName || authResult.device!.label,
    capabilities,
    tempDir,
    connectedAt: new Date(),
    lastActiveAt: new Date(),
    status: "connected",
  };

  devices.set(deviceId, {
    ws,
    session,
    pendingCommands: new Map(),
    pendingMemoryRequests: new Map(),
    pendingSkillRequests: new Map(),
    pendingPersonaRequests: new Map(),
    pendingCouncilRequests: new Map(),
    pendingThreadRequests: new Map(),
    pendingKnowledgeRequests: new Map(),
    pendingToolRequests: new Map(),
  });

  log.info(`Device authenticated: ${deviceName || authResult.device!.label} (${deviceId})`);

  sendMessage(ws, {
    type: "auth",
    id: nanoid(),
    timestamp: Date.now(),
    payload: {
      success: true,
      sessionId: session.id,
      provider: serverProvider,
      model: serverModel,
      webAuthToken: getWebAuthToken() || undefined,
    },
  });

  return deviceId;
}

