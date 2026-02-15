/**
 * WebSocket Server
 * 
 * Core server setup, authentication, and message routing.
 * 
 * Separated concerns:
 * - prompt-handler.ts — orchestrator logic for user prompts
 * - ../context/context-builder.ts — fetches memory, history, tools, personas for each prompt
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
import { createComponentLogger } from "#logging.js";

// Extracted modules
import {
  devices,
  sendMessage,
  sendError,
  getDeviceForUser,
  broadcastToUser,
  notifyAdminDevices,
  hasAnyConnectedDevices,
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
import { handlePrompt, cleanupUserSession } from "./prompt-handler.js";
import { sendExecutionCommand } from "./device-bridge.js";
import {
  listWorkspaceFolders,
  readTaskJson,
  categorizeIncompleteTasks,
  cleanupWorkspace,
  type TaskJson,
} from "#pipeline/workspace/index.js";
import { setExecuteCallback, onSchedulerEvent } from "../services/scheduler/index.js";
import type { DeferredTask } from "../services/scheduler/index.js";
import {
  setRecurringExecuteCallback,
  onRecurringEvent,
  getOfflineResults,
} from "../services/scheduler/index.js";
import type { RecurringTask } from "../services/scheduler/index.js";
import { validateAndConsumeToken } from "../auth/invite-tokens.js";
import { registerDevice, authenticateDevice, getRecentFailures, logAuthEvent, listDevices } from "../auth/device-store.js";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

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

// Server version — read from VERSION file at repo root
const SERVER_VERSION = (() => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const candidates = [
    path.resolve(__dirname, "..", "..", "VERSION"),       // dist/ws → repo root
    path.resolve(__dirname, "..", "..", "..", "VERSION"),  // deeper nesting
  ];
  for (const p of candidates) {
    try { return readFileSync(p, "utf-8").trim(); } catch {}
  }
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
    const syntheticMessage: WSPromptMessage = {
      type: "prompt" as const,
      id: `sched_${task.id}`,
      timestamp: Date.now(),
      payload: {
        prompt: `[Scheduled Task — ${task.deferReason}] ${task.originalPrompt}`,
        source: "scheduler",
      },
    };

    log.info("Executing deferred task via prompt pipeline", {
      taskId: task.id,
      userId: task.userId,
      deviceId,
      prompt: task.originalPrompt.substring(0, 80),
    });

    await handlePrompt(deviceId, syntheticMessage, options.apiKey, serverProvider);
    return `Deferred task ${task.id} executed via prompt pipeline`;
  });

  // #18: Wire recurring scheduler — recurring tasks route through V2 pipeline
  // V2 Flow: handlePrompt → receptionist → persona writer → orchestrator → judge
  // This ensures recurring tasks use full V2 architecture with proper persona selection
  setRecurringExecuteCallback(async (task: RecurringTask) => {
    const deviceId = getDeviceForUser(task.userId);

    // Build a synthetic prompt message
    const syntheticMessage: WSPromptMessage = {
      type: "prompt" as const,
      id: `rsched_${task.id}`,
      timestamp: Date.now(),
      payload: {
        prompt: task.prompt,
        source: "scheduled_task",
        hints: task.personaHint ? { personaHint: task.personaHint } : undefined,
      },
    };

    if (!deviceId) {
      // No device connected — cannot execute
      // Recurring tasks require a connected device because they may need client-side tools
      // The scheduler will automatically retry according to the task's schedule
      log.warn("Recurring task execution skipped - no connected device", {
        taskId: task.id,
        name: task.name,
        userId: task.userId,
        nextRetry: "Will retry on next schedule interval",
      });
      throw new Error(`No device connected for user ${task.userId} — task "${task.name}" will retry on next interval`);
    }

    log.info("Executing recurring task via V2 pipeline", {
      taskId: task.id,
      name: task.name,
      userId: task.userId,
      deviceId,
      flow: "handlePrompt → receptionist → persona writer → orchestrator → judge",
    });

    await handlePrompt(deviceId, syntheticMessage, options.apiKey, serverProvider);
    return `Recurring task "${task.name}" executed successfully via V2 pipeline`;
  });

  // #18b: Route recurring events to connected devices
  onRecurringEvent((event) => {
    if (!["recurring_completed", "recurring_failed", "recurring_paused"].includes(event.type)) return;

    const labels: Record<string, string> = {
      recurring_completed: `"${event.taskName}" completed`,
      recurring_failed: `"${event.taskName}" failed`,
      recurring_paused: `"${event.taskName}" paused (repeated failures)`,
    };

    broadcastToUser(event.userId, {
      type: "user_notification",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        source: "recurring_scheduler",
        level: event.type === "recurring_completed" ? "info" : "warning",
        title: labels[event.type] || event.type,
        taskId: event.taskId,
        taskName: event.taskName,
        details: event.details,
      },
    });
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
    let connectionKey: string | null = null;
    
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
            connectionKey = handleRegisterDevice(ws, message as WSRegisterDeviceMessage);
            deviceId = connectionKey; // registration is always agent
            break;
          case "auth":
            if (deviceId) { sendError(ws, "Already authenticated"); break; }
            connectionKey = handleAuth(ws, message as WSAuthMessage);
            deviceId = connectionKey?.replace(/:browser$/, '') || null;
            break;
          case "prompt":
            if (!deviceId) { sendError(ws, "Not authenticated"); return; }
            await handlePrompt(deviceId, message as WSPromptMessage, options.apiKey, serverProvider, ws);
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
              // V2: No background task cancellation needed - agents are session-based
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
      if (connectionKey) {
        const device = devices.get(connectionKey);
        // Only act if THIS WebSocket is still the current one for this connection.
        // If the agent reconnected, devices.get(connectionKey) returns the NEW connection
        // and we must NOT mark it disconnected or cancel its tasks.
        if (device && device.ws === ws) {
          const userId = device.session.userId;
          device.session.status = "disconnected";
          log.info(`Device disconnected: ${device.session.deviceName}`);
          // Only cancel running tasks when a LOCAL AGENT disconnects (tools become unavailable).
          // Browser clients are just display — closing a tab should NOT cancel agent work.
          // V2: No background task cancellation needed - agents are session-based
          const isLocalAgent = device.session.capabilities?.includes("memory");
          if (isLocalAgent) {
            log.info("Local-agent disconnect: V2 uses session-based agents, no cancellation needed", { deviceId });
          }
          if (deviceId) cleanupResolveTracking(deviceId);

          // Clean up V2 orchestrator state if this was the user's last device
          if (!hasAnyConnectedDevices(userId)) {
            log.info("User's last device disconnected — cleaning up V2 session state", { userId });
            cleanupUserSession(userId);
          }
        } else if (device) {
          log.debug(`Stale WS closed for ${connectionKey} — device already reconnected, ignoring`);
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
  const { inviteToken, label, hwFingerprint, capabilities, tempDir, platform } = message.payload;

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
    platform: platform || undefined,
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
    },
  });

  return deviceId;
}

// ============================================
// AUTH HANDLER
// ============================================

function handleAuth(ws: WebSocket, message: WSAuthMessage): string | null {
  const { deviceId, deviceSecret, deviceName, capabilities, tempDir, hwFingerprint, platform } = message.payload;

  const ip = (ws as any)._socket?.remoteAddress || "unknown";

  // Web clients authenticate with a web auth token (no device credentials).
  // These get capabilities: ['prompt'] only — no tool execution.
  // CRITICAL: Web clients must share the same userId as the local agent
  // Web clients without device credentials are rejected
  if (!deviceSecret || !hwFingerprint) {
    log.warn("Web client auth failed: missing device credentials", { ip, deviceId, hasSecret: !!deviceSecret, hasFingerprint: !!hwFingerprint });
    sendMessage(ws, {
      type: "auth_failed",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        reason: "missing_credentials",
        message: "Web clients must provide device credentials. Use the setup link provided by your local agent or an invite token."
      },
    });
    return null;
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

    sendMessage(ws, {
      type: "auth_failed",
      id: nanoid(),
      timestamp: Date.now(),
      payload: { reason: authResult.reason, message: `Authentication failed: ${authResult.reason}` },
    });
    return null;
  }

  // Security alert on fingerprint change (auth succeeded, fingerprint updated)
  if (authResult.fingerprintChanged) {
    notifyAdminDevices({
      title: "⚠️ Hardware Fingerprint Changed",
      message: `Device \`${deviceId}\` (\`${authResult.device!.label}\`) authenticated from IP \`${ip}\` with a different hardware fingerprint. Fingerprint has been updated. This is normal after a code update but may indicate credential theft if unexpected.`,
      level: "warning",
    });
  }

  // Determine if this is an agent (has "memory" capability) or a browser client
  const isAgent = capabilities.includes("memory");
  const connectionKey = isAgent ? deviceId : `${deviceId}:browser`;

  // If this connection type was already connected (reconnect), close the old WS gracefully
  // Agent reconnects only kick agents; browser reconnects only kick browsers
  const existingDevice = devices.get(connectionKey);
  if (existingDevice && existingDevice.ws !== ws) {
    log.info(`Device ${connectionKey} reconnecting — closing stale WebSocket`);
    try { existingDevice.ws.close(); } catch { /* already closed */ }
  }

  const session: DeviceSession = {
    id: nanoid(),
    userId: `user_${deviceId}`,
    deviceId,
    deviceName: deviceName || authResult.device!.label,
    capabilities,
    tempDir,
    platform: platform || undefined,
    connectedAt: new Date(),
    lastActiveAt: new Date(),
    status: "connected",
  };

  devices.set(connectionKey, {
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

  log.info(`Device authenticated: ${deviceName || authResult.device!.label} (${connectionKey})`);

  sendMessage(ws, {
    type: "auth",
    id: nanoid(),
    timestamp: Date.now(),
    payload: {
      success: true,
      sessionId: session.id,
      deviceId,
      provider: serverProvider,
      model: serverModel,
    },
  });

  // Version check: if agent is behind server, push an update command
  if (isAgent) {
    const agentVersion = message.payload.version;
    if (agentVersion && SERVER_VERSION !== "unknown" && agentVersion !== SERVER_VERSION) {
      log.info("Agent version mismatch — pushing update", {
        deviceId,
        agentVersion,
        serverVersion: SERVER_VERSION,
      });
      // Small delay so the agent finishes its auth init before we trigger an update
      setTimeout(() => {
        sendMessage(ws, {
          type: "system_update" as any,
          id: nanoid(),
          timestamp: Date.now(),
          payload: {
            serverVersion: SERVER_VERSION,
            agentVersion,
            reason: `Server updated to ${SERVER_VERSION}, agent is on ${agentVersion}`,
          },
        });
      }, 5000);
    }
  }

  // V2: Check for incomplete agent workspaces (async, non-blocking) — agents only
  if (isAgent) {
    // checkIncompleteWorkspaces(deviceId, session.userId).catch(() => {});
  }

  // Part 18: Notify about recurring tasks that ran while device was offline
  notifyOfflineRecurringResults(session.userId, session.connectedAt).catch(() => {});

  return connectionKey;
}

/**
 * V2: Scan client's agent-workspaces/ for incomplete task.json files.
 * Runs after auth — notifies the user of any resumable/failed tasks.
 * Silently does nothing if workspace folder doesn't exist.
 */
async function checkIncompleteWorkspaces(deviceId: string, userId: string): Promise<void> {
  try {
    const listCmd = listWorkspaceFolders();
    const listResult = await sendExecutionCommand(deviceId, {
      id: `resume_list_${nanoid(8)}`,
      type: "tool_execute",
      payload: { toolId: listCmd.toolId, toolArgs: listCmd.args },
      dryRun: false, timeout: 5000, sandboxed: false, requiresApproval: false,
    });

    // Parse folder listing — expect JSON array or newline-separated names
    let folders: string[];
    try {
      folders = JSON.parse(listResult);
      if (!Array.isArray(folders)) return;
    } catch {
      folders = listResult.split("\n").map(s => s.trim()).filter(Boolean);
    }
    if (folders.length === 0) return;

    // Read task.json from each workspace folder
    const tasks: TaskJson[] = [];
    for (const folder of folders) {
      try {
        const readCmd = readTaskJson(folder);
        const readResult = await sendExecutionCommand(deviceId, {
          id: `resume_read_${nanoid(8)}`,
          type: "tool_execute",
          payload: { toolId: readCmd.toolId, toolArgs: readCmd.args },
          dryRun: false, timeout: 5000, sandboxed: false, requiresApproval: false,
        });
        const taskData = JSON.parse(readResult) as TaskJson;
        tasks.push(taskData);
      } catch {
        // No task.json = completed task, clean up old workspace folder
        const cleanCmd = cleanupWorkspace(folder);
        sendExecutionCommand(deviceId, {
          id: `resume_clean_${nanoid(8)}`,
          type: "tool_execute",
          payload: { toolId: cleanCmd.toolId, toolArgs: cleanCmd.args },
          dryRun: false, timeout: 5000, sandboxed: false, requiresApproval: false,
        }).catch(() => {});
      }
    }

    if (tasks.length === 0) return;

    const { resumable, failed, blocked } = categorizeIncompleteTasks(tasks);

    // Build a summary message for the user
    const parts: string[] = [];
    if (resumable.length > 0) {
      parts.push(`**${resumable.length} paused task${resumable.length > 1 ? "s" : ""}:** ${resumable.map(t => t.topic).join(", ")}`);
    }
    if (blocked.length > 0) {
      parts.push(`**${blocked.length} blocked task${blocked.length > 1 ? "s" : ""}:** ${blocked.map(t => t.topic).join(", ")}`);
    }
    if (failed.length > 0) {
      parts.push(`**${failed.length} failed task${failed.length > 1 ? "s" : ""}:** ${failed.map(t => `${t.topic} (${t.failureReason?.substring(0, 80) || "unknown error"})`).join(", ")}`);
    }

    if (parts.length > 0) {
      broadcastToUser(userId, {
        type: "response",
        id: nanoid(),
        timestamp: Date.now(),
        payload: {
          success: true,
          response: `I found incomplete agent tasks from a previous session:\n\n${parts.join("\n")}\n\nYou can ask me to resume or discard them.`,
          classification: "CONVERSATIONAL",
          threadIds: [],
          keyPoints: [],
        }
      });
    }

    log.info("Incomplete workspace scan complete", {
      resumable: resumable.length,
      failed: failed.length,
      blocked: blocked.length,
    });
  } catch (error) {
    // Non-fatal — don't crash auth for workspace scanning
    log.debug("Workspace scan skipped (no workspaces or local-agent not ready)", { error });
  }
}

/**
 * Part 18: Notify user about recurring tasks that ran while their device was offline.
 * Checks for tasks where last_run_at > device's previous session end.
 */
async function notifyOfflineRecurringResults(userId: string, connectedAt: Date): Promise<void> {
  try {
    // Use connectedAt as approximate "last seen" — tasks that ran before this are offline results
    const offlineResults = getOfflineResults(userId, connectedAt);
    if (offlineResults.length === 0) return;

    const summary = offlineResults.map(t => {
      const status = t.lastError ? `failed: ${t.lastError.substring(0, 100)}` : "completed";
      const result = t.lastResult ? t.lastResult.substring(0, 200) : "";
      return `- **${t.name}** (${status})${result ? `: ${result}...` : ""}`;
    }).join("\n");

    broadcastToUser(userId, {
      type: "response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        success: true,
        response: `While you were away, ${offlineResults.length} scheduled task${offlineResults.length > 1 ? "s" : ""} ran:\n\n${summary}\n\nUse \`schedule.list\` to see full details.`,
        classification: "CONVERSATIONAL",
        threadIds: [],
        keyPoints: [],
      },
    });

    log.info("Notified user of offline recurring results", {
      userId,
      count: offlineResults.length,
    });
  } catch (error) {
    log.debug("Offline recurring results check skipped", { error });
  }
}

