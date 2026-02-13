/**
 * DotBot Local Agent
 * 
 * Slim WS client core. Connects to the cloud server, routes messages
 * to handler modules, provides CLI interface.
 * 
 * Handler modules:
 * - handlers/memory-handlers.ts  — memory + skill requests
 * - handlers/discovery-handlers.ts — persona, council, knowledge
 * - handlers/resource-handlers.ts — execution, schema, threads, assets
 */

import WebSocket from "ws";
import { nanoid } from "nanoid";
import { promises as fs, readFileSync, writeFileSync } from "fs";
import path from "path";
import type { WSMessage } from "./types.js";
import * as memory from "./memory/index.js";
import { DOTBOT_DIR, TEMP_DIR } from "./memory/store-core.js";
import { appendAgentWork } from "./memory/store-agent-work.js";
import { initSleepCycle, stopSleepCycle, executeSleepCycle, setSleepCycleLoopCallback, CYCLE_INTERVAL_MS } from "./memory/sleep-cycle.js";
import {
  initHeartbeat, stopHeartbeat, executeHeartbeat, canRunHeartbeat,
  getHeartbeatIntervalMs, isHeartbeatEnabled,
} from "./heartbeat/heartbeat.js";
import {
  startPeriodicManager, stopPeriodicManager,
  notifyActivity,
  type PeriodicTaskDef,
} from "./periodic/index.js";
import { startSetupServer } from "./setup-server.js";
import { initServerLLM, handleServerLLMResponse } from "./server-llm.js";
import {
  initCredentialProxy,
  handleProxyResponse,
  handleSessionReady,
  handleCredentialStored,
  handleResolveResponse,
} from "./credential-proxy.js";
import { initDiscordAdapter, stopDiscordAdapter, handleDiscordResponse, sendToConversationChannel, sendToUpdatesChannel, sendToLogsChannel } from "./discord/adapter.js";
import { checkReminders, canCheckReminders, setReminderNotifyCallback } from "./reminders/checker.js";
import { checkOnboarding, canCheckOnboarding, setOnboardingNotifyCallback, setOnboardingDiscordCallback } from "./onboarding/checker.js";
import { onboardingExists, initOnboarding } from "./onboarding/store.js";
import { checkForUpdates, canCheckForUpdates, setUpdateNotifyCallback } from "./onboarding/update-checker.js";
import { vaultSetServerBlob } from "./credential-vault.js";
import { loadDeviceCredentials, saveDeviceCredentials } from "./auth/device-credentials.js";
import { collectHardwareFingerprint } from "./auth/hw-fingerprint.js";

// Extracted handlers
import { handleMemoryRequest, handleSkillRequest } from "./handlers/memory-handlers.js";
import { handlePersonaRequest, handleCouncilRequest, handleKnowledgeRequest, handleKnowledgeQuery, handleToolRequest } from "./handlers/discovery-handlers.js";
import { initToolRegistry } from "./tools/registry.js";
import { setPreRestartHook } from "./tools/tool-executor.js";
import { setAdminRequestSender } from "./tools/tool-handlers-admin.js";
import { processFormatFixes } from "./handlers/format-fixer.js";
import type { MalformedFile } from "./memory/startup-validator.js";
import {
  handleExecutionRequest, handleSchemaRequest,
  handleThreadRequest, handleThreadUpdate, handleSaveToThread,
  handleStoreAsset, handleRetrieveAsset, handleCleanupAssets,
} from "./handlers/resource-handlers.js";

// ============================================
// LOAD ~/.bot/.env INTO process.env
// ============================================

function loadBotEnv(): void {
  const envPath = path.resolve(process.env.USERPROFILE || process.env.HOME || "", ".bot", ".env");
  try {
    let content = readFileSync(envPath, "utf-8");
    // Strip UTF-8 BOM — PowerShell 5.1 Set-Content -Encoding UTF8 always adds one
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.substring(0, eqIdx).trim();
        const value = trimmed.substring(eqIdx + 1).trim();
        // Don't overwrite existing env vars (CLI/system take precedence)
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  } catch {
    // ~/.bot/.env doesn't exist yet — that's fine
  }
}

loadBotEnv();

function cleanConsumedInviteToken(): void {
  const envPath = path.resolve(process.env.USERPROFILE || process.env.HOME || "", ".bot", ".env");
  try {
    let content = readFileSync(envPath, "utf-8");
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
    const filtered = content
      .split(/\r?\n/)
      .filter(line => !line.trim().startsWith("DOTBOT_INVITE_TOKEN="))
      .join("\n");
    if (filtered !== content) {
      writeFileSync(envPath, filtered, "utf-8");
      console.log("[Agent] Removed consumed invite token from .env");
    }
  } catch {
    // .env doesn't exist or can't be written — not critical
  }
}

// ============================================
// CONFIGURATION
// ============================================

function normalizeServerUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, ""); // trim + strip trailing slashes

  // Detect corrupted .env (missing newlines between keys)
  if (url.includes("DOTBOT_") || url.includes("=")) {
    console.error("[Agent] FATAL: DOTBOT_SERVER value is corrupted (contains other .env keys).");
    console.error(`[Agent]   Raw value: ${url.slice(0, 120)}`);
    console.error("[Agent]   Fix: delete ~/.bot/.env and re-run the installer, or manually edit the file");
    console.error("[Agent]   Each key=value pair must be on its own line.");
    process.exit(1);
  }

  // Fix scheme: https:// → wss://, http:// → ws://
  if (url.startsWith("https://")) url = "wss://" + url.slice(8);
  else if (url.startsWith("http://")) url = "ws://" + url.slice(7);

  // No scheme at all → add wss:// for domains, ws:// for localhost
  if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
    const isLocal = /^(localhost|127\.0\.0\.1)(:|$)/.test(url);
    url = (isLocal ? "ws://" : "wss://") + url;
  }

  // Remote servers (not localhost) need /ws path for Caddy routing
  const isLocalhost = /^wss?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url);
  if (!isLocalhost && !url.endsWith("/ws")) {
    url = url + "/ws";
  }

  return url;
}

function autoCorrectServerUrl(): string {
  const raw = process.env.DOTBOT_SERVER || "ws://localhost:3001";
  const corrected = normalizeServerUrl(raw);

  if (corrected !== raw && process.env.DOTBOT_SERVER) {
    console.log(`[Agent] Auto-corrected server URL:`);
    console.log(`[Agent]   was: ${raw}`);
    console.log(`[Agent]   now: ${corrected}`);

    // Update ~/.bot/.env so the fix persists
    const envPath = path.resolve(process.env.USERPROFILE || process.env.HOME || "", ".bot", ".env");
    try {
      let content = readFileSync(envPath, "utf-8");
      if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
      const updated = content
        .split(/\r?\n/)
        .map(line => line.trim().startsWith("DOTBOT_SERVER=") ? `DOTBOT_SERVER=${corrected}` : line)
        .join("\n");
      if (updated !== content) {
        writeFileSync(envPath, updated, "utf-8");
        console.log("[Agent] Updated ~/.bot/.env with corrected URL");
      }
    } catch {
      // Can't update .env — not critical, the in-memory value is fixed
    }

    process.env.DOTBOT_SERVER = corrected;
  }

  return corrected;
}

const SERVER_URL = autoCorrectServerUrl();
const DEVICE_NAME = process.env.DEVICE_NAME || `Windows-${process.env.COMPUTERNAME || "PC"}`;

// Device credentials (loaded from ~/.bot/device.json after registration)
let deviceCredentials = loadDeviceCredentials();

// Hardware fingerprint — computed once at startup, held in memory only.
// NEVER exposed to LLM context or any tool.
let hwFingerprint: string = "";
try {
  hwFingerprint = collectHardwareFingerprint();
  console.log("[Agent] Hardware fingerprint computed");
} catch (err) {
  console.error("[Agent] Failed to compute hardware fingerprint:", err);
  process.exit(1);
}

// ============================================
// WEBSOCKET CLIENT
// ============================================

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let failingSinceMs = 0;
let pendingFormatFixes: MalformedFile[] = [];
const MAX_RECONNECT_ATTEMPTS = 50;
const BASE_RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const CIRCUIT_BREAKER_MS = 60 * 60 * 1000; // 1 hour

// Pending server responses for async request/response (sleep cycle condense, resolve loop)
const pendingServerResponses = new Map<string, { resolve: (value: any) => void; reject: (err: any) => void }>();
const PENDING_TIMEOUT_MS = 120_000; // 2 minutes for LLM processing

function connect(): void {
  console.log(`[Agent] Connecting to ${SERVER_URL}...`);
  
  ws = new WebSocket(SERVER_URL);

  ws.on("open", () => {
    console.log("[Agent] Connected! Authenticating...");
    reconnectAttempts = 0;
    failingSinceMs = 0;
    authenticate();
  });

  ws.on("message", async (data) => {
    try {
      const message: WSMessage = JSON.parse(data.toString());
      await handleMessage(message);
    } catch (error) {
      console.error("[Agent] Failed to parse message:", error);
    }
  });

  ws.on("close", () => {
    console.log("[Agent] Disconnected");
    scheduleReconnect();
  });

  ws.on("error", (error) => {
    console.error("[Agent] WebSocket error:", error);
  });
}

function scheduleReconnect(): void {
  if (!failingSinceMs) failingSinceMs = Date.now();
  const failingDuration = Date.now() - failingSinceMs;

  // Circuit breaker: after 1 hour of continuous failures, exit permanently (code 1)
  if (failingDuration > CIRCUIT_BREAKER_MS) {
    console.error(`[Agent] Server unreachable for over 1 hour. Exiting permanently (not restarting).`);
    console.error(`[Agent] Check server status and restart the agent manually.`);
    process.exit(1);
  }

  if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    reconnectAttempts++;
    // Exponential backoff: 2s, 4s, 8s, 16s, 32s, capped at 60s
    const delay = Math.min(BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS);
    console.log(`[Agent] Reconnecting in ${(delay/1000).toFixed(0)}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}, failing for ${Math.round(failingDuration/1000)}s)...`);
    setTimeout(connect, delay);
  } else {
    // Exit with restart signal so the launcher restarts us with a clean slate
    console.error(`[Agent] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Exiting with restart signal.`);
    process.exit(42);
  }
}

function send(message: WSMessage): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

/**
 * Send a message to the server and wait for a matching response.
 * Used by the sleep cycle to do request/response over WebSocket.
 * The response is matched by requestId in the payload.
 */
function sendAndWaitForResponse(message: WSMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const requestId = message.id;
    pendingServerResponses.set(requestId, { resolve, reject });

    // Timeout — don't wait forever
    const timer = setTimeout(() => {
      if (pendingServerResponses.has(requestId)) {
        pendingServerResponses.delete(requestId);
        resolve(null); // Resolve with null on timeout, don't crash the cycle
      }
    }, PENDING_TIMEOUT_MS);

    // Clean up timer when resolved
    const original = pendingServerResponses.get(requestId)!;
    pendingServerResponses.set(requestId, {
      resolve: (value: any) => {
        clearTimeout(timer);
        original.resolve(value);
      },
      reject: (err: any) => {
        clearTimeout(timer);
        original.reject(err);
      },
    });

    send(message);
  });
}

/**
 * Handle a response from the server that matches a pending request.
 * Routes condense_response and resolve_loop_response back to the sleep cycle.
 */
function handlePendingResponse(message: WSMessage): void {
  const requestId = message.payload?.requestId;
  if (!requestId) return;

  const pending = pendingServerResponses.get(requestId);
  if (pending) {
    pendingServerResponses.delete(requestId);
    pending.resolve(message.payload);
  }
}

// ============================================
// RESTART QUEUE — Re-submit prompts after restart
// ============================================

const RESTART_QUEUE_PATH = path.join(DOTBOT_DIR, "restart-queue.json");

async function resubmitRestartQueue(sendFn: (msg: WSMessage) => void): Promise<void> {
  try {
    const raw = await fs.readFile(RESTART_QUEUE_PATH, "utf-8");
    const queue = JSON.parse(raw);
    const prompts: string[] = queue.prompts || [];
    if (prompts.length === 0) return;

    // Delete the file first so we don't re-submit on every reconnect
    await fs.unlink(RESTART_QUEUE_PATH).catch(() => {});

    console.log(`[Agent] Re-submitting ${prompts.length} prompt(s) from pre-restart queue`);
    for (const prompt of prompts) {
      sendFn({
        type: "prompt",
        id: nanoid(),
        timestamp: Date.now(),
        payload: {
          prompt: `[Resumed after restart] ${prompt}`,
          source: "restart_queue",
        },
      });
    }
  } catch {
    // No restart queue file — normal startup, nothing to do
  }
}

// ============================================
// AUTHENTICATION
// ============================================

function authenticate(): void {
  const capabilities = ["powershell", "file_read", "file_write", "schema_extract", "memory", "skills"];

  // Detect platform for V2 tool filtering
  const nodePlatform = process.platform;
  const platform = nodePlatform === "win32" ? "windows"
    : nodePlatform === "darwin" ? "macos"
    : "linux";

  if (deviceCredentials) {
    // Existing device — authenticate with stored credentials
    send({
      type: "auth",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        deviceId: deviceCredentials.deviceId,
        deviceSecret: deviceCredentials.deviceSecret,
        deviceName: DEVICE_NAME,
        capabilities,
        tempDir: TEMP_DIR,
        hwFingerprint,
        platform,
      },
    });
  } else {
    // New device — register with invite token
    const inviteToken = process.env.DOTBOT_INVITE_TOKEN;
    if (!inviteToken) {
      console.error("[Agent] No device credentials found and no DOTBOT_INVITE_TOKEN set.");
      console.error("[Agent] Set DOTBOT_INVITE_TOKEN in ~/.bot/.env or environment to register this device.");
      process.exit(1);
    }
    console.log("[Agent] No device credentials found — registering with invite token...");
    send({
      type: "register_device",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        inviteToken,
        label: DEVICE_NAME,
        hwFingerprint,
        capabilities,
        tempDir: TEMP_DIR,
        platform,
      },
    });
  }
}

// ============================================
// MESSAGE HANDLING
// ============================================

async function handleMessage(message: WSMessage): Promise<void> {
  // Reset idle clock on any server-initiated request (indicates active conversation)
  // Don't reset on keepalive messages — ping/pong are connection health, not user activity
  if (message.type !== "auth" && message.type !== "ping" && message.type !== "pong") {
    notifyActivity();
  }

  switch (message.type) {
    case "device_registered":
    case "auth": {
      // Handle both device_registered (first-time) and auth (reconnect) with shared logic
      if (message.type === "device_registered") {
        // First-time registration — save credentials
        const { deviceId, deviceSecret } = message.payload;
        console.log(`[Agent] Device registered successfully! ID: ${deviceId}`);
        deviceCredentials = {
          deviceId,
          deviceSecret,
          serverUrl: SERVER_URL,
          registeredAt: new Date().toISOString(),
          label: DEVICE_NAME,
        };
        saveDeviceCredentials(deviceCredentials);
        console.log("[Agent] Credentials saved to ~/.bot/device.json");
        // Clean consumed invite token from .env (it's used up, no reason to keep it)
        cleanConsumedInviteToken();
        // Continue to shared initialization below
      } else if (!message.payload.success) {
        // Auth message with success=false (shouldn't happen, but defensive)
        console.error("[Agent] Authentication failed");
        break;
      }

      // Shared initialization for both registration and auth success
      {
        console.log("[Agent] Authenticated successfully!");
        console.log("[Agent] Ready for commands.");

        // Start local setup server for secure browser authentication
        // Use message payload (first registration) or saved credentials (reconnect)
        const setupDeviceId = message.payload.deviceId || deviceCredentials?.deviceId;
        const setupDeviceSecret = message.payload.deviceSecret || deviceCredentials?.deviceSecret;
        if (setupDeviceId && setupDeviceSecret) {
          // Convert WebSocket URL to HTTP URL for browser redirect
          const httpUrl = SERVER_URL.replace(/^wss?:\/\//, (match) => match === 'wss://' ? 'https://' : 'http://');

          try {
            const { port, setupCode } = startSetupServer(
              setupDeviceId,
              setupDeviceSecret,
              httpUrl
            );

            console.log("");
            console.log("╔════════════════════════════════════════════════════════╗");
            console.log("║                                                        ║");
            console.log("║  🌐 Setup Browser Access                               ║");
            console.log("║                                                        ║");
            console.log(`║  Open this link to configure credentials:             ║`);
            console.log(`║  http://localhost:${port}/setup?code=${setupCode}         ║`);
            console.log("║                                                        ║");
            console.log("╚════════════════════════════════════════════════════════╝");
            console.log("");
          } catch (err) {
            console.warn("[Agent] Setup server failed to start:", err);
            // Not critical — user can enter credentials via other means
          }
        }
        // Initialize subsystems with server sender
        initCredentialProxy(send);
        initServerLLM(send);

        // Wire admin tool handler to send admin_request over WS
        setAdminRequestSender(async (payload: any) => {
          const msgId = nanoid();
          const response = await sendAndWaitForResponse({
            type: "admin_request",
            id: msgId,
            timestamp: Date.now(),
            payload: { ...payload, requestId: msgId },
          });
          return response;
        });

        // Wire pre-restart hook: cancel server tasks before process.exit(42)
        // and save their prompts to disk so they can be re-submitted after restart
        setPreRestartHook(() => new Promise<void>((resolve) => {
          const RESTART_CANCEL_TIMEOUT_MS = 3000;

          // One-shot listener for the ack
          const ackListener = (data: any) => {
            try {
              const msg: WSMessage = JSON.parse(data.toString());
              if (msg.type === "cancel_before_restart_ack") {
                ws?.off("message", ackListener);
                clearTimeout(timer);
                const cancelled = msg.payload?.cancelled ?? 0;
                const prompts: string[] = msg.payload?.prompts ?? [];
                console.log(`[System] Server cancelled ${cancelled} task(s) before restart`);
                // Save prompts for re-submission after restart
                if (prompts.length > 0) {
                  fs.writeFile(RESTART_QUEUE_PATH, JSON.stringify({ prompts, savedAt: new Date().toISOString() }), "utf-8")
                    .then(() => console.log(`[System] Saved ${prompts.length} prompt(s) to restart queue`))
                    .catch((err) => console.error("[System] Failed to save restart queue:", err))
                    .finally(() => resolve());
                  return;
                }
                resolve();
              }
            } catch { /* ignore parse errors */ }
          };
          ws?.on("message", ackListener);

          // Timeout: don't wait forever
          const timer = setTimeout(() => {
            ws?.off("message", ackListener);
            console.warn("[System] Cancel-before-restart timed out — proceeding with restart");
            resolve();
          }, RESTART_CANCEL_TIMEOUT_MS);

          // Send the cancel request
          send({
            type: "cancel_before_restart",
            id: nanoid(),
            timestamp: Date.now(),
            payload: {},
          });
        }));

        // Re-submit prompts from previous restart (if any)
        resubmitRestartQueue(send);

        initSleepCycle(sendAndWaitForResponse);

        // Wire sleep cycle loop notifications → Discord #conversation
        setSleepCycleLoopCallback((modelName, loopDescription, notification, newStatus) => {
          const emoji = newStatus === "resolved" ? "✅" : "💡";
          const statusLabel = newStatus === "resolved" ? "Loop closed" : "New info";
          sendToConversationChannel(
            `${emoji} **${statusLabel}: ${modelName}**\n_${loopDescription}_\n\n${notification}`
          );
          sendToUpdatesChannel(`🔄 Sleep cycle — ${statusLabel.toLowerCase()} on "${modelName}": ${loopDescription}`);
        });

        initHeartbeat(sendAndWaitForResponse, undefined, {
          enabled: process.env.HEARTBEAT_ENABLED !== "false",
          intervalMs: process.env.HEARTBEAT_INTERVAL_MIN
            ? parseInt(process.env.HEARTBEAT_INTERVAL_MIN, 10) * 60 * 1000
            : 5 * 60 * 1000,
          activeHours: (process.env.HEARTBEAT_ACTIVE_START && process.env.HEARTBEAT_ACTIVE_END)
            ? { start: process.env.HEARTBEAT_ACTIVE_START, end: process.env.HEARTBEAT_ACTIVE_END }
            : undefined,
        });

        // Wire scheduled task checker
        // Wire reminder notifications → Discord #conversation + #updates
        setReminderNotifyCallback((reminder) => {
          const emoji = reminder.priority === "P0" ? "🚨" : "🔔";
          const msg = `${emoji} **Reminder:** ${reminder.message}`;
          sendToConversationChannel(msg);
          sendToUpdatesChannel(`${msg}\n_Scheduled for: ${reminder.scheduledFor}_`);
        });

        // Wire onboarding nag notifications → Discord #updates
        setOnboardingNotifyCallback((message) => {
          sendToUpdatesChannel(`💡 ${message}`);
        });

        // Wire onboarding 7-day escalation → Discord #conversation
        setOnboardingDiscordCallback((message) => {
          sendToUpdatesChannel(message);
        });

        // Wire update notifications → Discord #updates
        setUpdateNotifyCallback((message) => {
          sendToUpdatesChannel(`🔄 ${message}`);
        });

        // Start the unified periodic manager (#8)
        const periodicTasks: PeriodicTaskDef[] = [
          {
            id: "heartbeat",
            name: "Heartbeat Check",
            intervalMs: getHeartbeatIntervalMs(),
            initialDelayMs: 60_000, // 1 minute after startup
            enabled: isHeartbeatEnabled(),
            run: (idleMs) => executeHeartbeat(idleMs),
            canRun: canRunHeartbeat,
          },
          {
            id: "reminder-check",
            name: "Reminder Check",
            intervalMs: 15_000, // Check every 15s (instant — just reads a JSON file)
            initialDelayMs: 10_000, // 10 seconds after startup
            enabled: true,
            bypassIdleCheck: true, // Reminders must fire on schedule, not wait for idle
            run: () => checkReminders(),
            canRun: canCheckReminders,
          },
          {
            id: "sleep-cycle",
            name: "Memory Consolidation",
            intervalMs: CYCLE_INTERVAL_MS,
            initialDelayMs: 2 * 60 * 1000, // 2 minutes after startup
            enabled: true,
            run: () => executeSleepCycle(),
          },
          {
            id: "onboarding-check",
            name: "Onboarding Check",
            intervalMs: 60 * 60 * 1000, // Check once per hour (nag logic limits to once/day)
            initialDelayMs: 5 * 60 * 1000, // 5 minutes after startup
            enabled: true,
            run: () => checkOnboarding(),
            canRun: canCheckOnboarding,
          },
          {
            id: "update-check",
            name: "Update Check",
            intervalMs: 6 * 60 * 60 * 1000, // Check every 6 hours
            initialDelayMs: 10 * 60 * 1000, // 10 minutes after startup
            enabled: true,
            run: () => checkForUpdates(),
            canRun: canCheckForUpdates,
          },
        ];
        startPeriodicManager(periodicTasks);
        // Process pending format fixes if user opted in
        if (pendingFormatFixes.length > 0) {
          const fixes = pendingFormatFixes;
          pendingFormatFixes = [];
          processFormatFixes(fixes, sendAndWaitForResponse).catch(err => {
            console.error("[Agent] Format fix processing failed:", err);
            send({
              type: "user_notification",
              id: nanoid(),
              timestamp: Date.now(),
              payload: { level: "warn", message: `Format fix processing failed: ${err instanceof Error ? err.message : String(err)}` },
            });
          });
        }

        // Start Discord adapter (non-blocking — skips if not configured)
        initDiscordAdapter(send).catch(err => {
          console.error("[Agent] Discord adapter init failed:", err);
        });

        // First-launch detection: if no onboarding.json exists, this is a fresh install
        // Initialize onboarding tracker and send a prompt to trigger the onboarding skill
        onboardingExists().then(async (exists) => {
          if (!exists) {
            console.log("[Agent] First launch detected — initializing onboarding");
            await initOnboarding();
            // Send a synthetic prompt to trigger the onboarding conversation
            send({
              type: "prompt",
              id: nanoid(),
              timestamp: Date.now(),
              payload: {
                prompt: "This is my first time using DotBot. Please start the onboarding process to help me get set up.",
                source: "system",
              },
            });
          }
        }).catch(err => {
          console.error("[Agent] Onboarding check failed:", err);
        });
      }
      break;
    }

    case "auth_failed": {
      const { reason, message: msg } = message.payload;
      console.error(`[Agent] Authentication failed: ${msg || reason}`);
      if (reason === "fingerprint_mismatch") {
        console.error("[Agent] SECURITY: Hardware fingerprint mismatch — device has been revoked by the server.");
        console.error("[Agent] You must obtain a new invite token and re-register this device.");
        console.error("[Agent] Delete ~/.bot/device.json and set DOTBOT_INVITE_TOKEN to re-register.");
      } else if (reason === "device_revoked") {
        console.error("[Agent] This device has been revoked by the server administrator.");
        console.error("[Agent] Contact your admin for a new invite token.");
      } else if (reason === "rate_limited") {
        console.error("[Agent] Too many failed authentication attempts from this IP.");
        console.error("[Agent] Wait 15 minutes before trying again.");
      } else if (reason === "invalid_token" || reason === "token_expired" || reason === "token_consumed" || reason === "token_revoked") {
        console.error("[Agent] The invite token is invalid or has been used/expired.");
        console.error("[Agent] Request a new invite token from the server administrator.");
      }
      // Don't reconnect on auth failure — it will just fail again
      process.exit(1);
      break; // unreachable but satisfies linter
    }

    case "execution_request":
      await handleExecutionRequest(message.payload, send);
      break;

    case "schema_request":
      await handleSchemaRequest(message.payload, send);
      break;

    case "memory_request":
      await handleMemoryRequest(message.payload, send);
      break;

    case "skill_request":
      await handleSkillRequest(message.payload, send);
      break;

    case "persona_request":
      await handlePersonaRequest(message, send);
      break;

    case "council_request":
      await handleCouncilRequest(message, send);
      break;

    case "knowledge_request":
      await handleKnowledgeRequest(message, send);
      break;

    case "knowledge_query":
      await handleKnowledgeQuery(message, send);
      break;

    case "tool_request":
      await handleToolRequest(message, send);
      break;

    case "thread_request":
      await handleThreadRequest(message, send);
      break;

    case "thread_update":
      await handleThreadUpdate(message);
      break;

    case "save_to_thread":
      await handleSaveToThread(message);
      break;

    case "store_asset":
      await handleStoreAsset(message, send);
      break;

    case "retrieve_asset":
      await handleRetrieveAsset(message, send);
      break;

    case "cleanup_assets":
      await handleCleanupAssets(message);
      break;

    case "task_progress": {
      // Route to Discord if applicable, then display locally
      await handleDiscordResponse(message);
      const { status, message: msg, persona, eventType } = message.payload;
      if (msg) console.log(`[Task] ${status}: ${msg}`);
      // Forward tool activity to Discord #logs channel (internal activity stream)
      if (msg && eventType) {
        const icon = eventType === "tool_call" ? "🔧" : eventType === "tool_result" ? (message.payload.success ? "✅" : "❌") : "💭";
        sendToLogsChannel(`${icon} ${persona ? `[${persona}] ` : ""}${msg}`, "detail");
      }
      break;
    }

    case "stream_chunk":
      // Display streaming response
      if (message.payload.content) {
        process.stdout.write(message.payload.content);
      }
      if (message.payload.done) {
        console.log("\n");
      }
      // Forward agent reasoning/dialog to Discord #logs channel
      if (message.payload.content && !message.payload.done) {
        const trimmed = message.payload.content.trim();
        if (trimmed) {
          sendToLogsChannel(`💭 ${trimmed.substring(0, 1900)}`, "detail");
        }
      }
      break;

    case "response":
      // Route to Discord if this was a Discord-originated prompt
      if (!(await handleDiscordResponse(message))) {
        console.log("\n[Response]", message.payload.response);
      }
      break;

    case "error":
      console.error("[Error]", message.payload.error);
      break;

    case "condense_response":
    case "resolve_loop_response":
    case "format_fix_response":
    case "heartbeat_response":
    case "admin_response":
      // Route response back to pending request
      handlePendingResponse(message);
      break;

    case "credential_session_ready":
      handleSessionReady(message.payload);
      break;

    case "credential_stored": {
      // Server encrypted a credential — store the blob in vault
      const stored = handleCredentialStored(message.payload);
      if (stored) {
        vaultSetServerBlob(stored.keyName, stored.blob).then(() => {
          console.log(`[Agent] Credential "${stored.keyName}" stored securely (server-encrypted)`);
        }).catch(err => {
          console.error(`[Agent] Failed to store credential blob:`, err);
        });
      }
      break;
    }

    case "credential_proxy_response":
      handleProxyResponse(message.payload);
      break;

    case "llm_call_response":
      handleServerLLMResponse(message.payload);
      break;

    case "credential_resolve_response":
      handleResolveResponse(message.payload);
      break;

    case "user_notification":
      console.log(`\n[Notification] ${message.payload.title || "Update"}: ${message.payload.message}`);
      // Sleep cycle loop notifications are handled by the setSleepCycleLoopCallback — skip to avoid duplicates.
      // Other notification sources go to both #conversation and #updates.
      if (message.payload?.message && message.payload?.source !== "sleep_cycle") {
        sendToConversationChannel(`🔔 **${message.payload.title || "Notification"}**\n${message.payload.message}`);
        sendToUpdatesChannel(`🔔 **${message.payload.title || "Notification"}**\n${message.payload.message}`);
      }
      break;

    case "task_acknowledged":
      // Server classified the prompt and is about to start agent execution.
      // Notify the user immediately via Discord #conversation so they know we're working on it.
      if (message.payload?.acknowledgment) {
        const prompt = message.payload.prompt || "your request";
        const eta = message.payload.estimatedLabel || "a moment";
        console.log(`[Task] Acknowledged: ${prompt} (est. ${eta})`);
        sendToConversationChannel(`⏳ ${message.payload.acknowledgment}`);
        sendToLogsChannel(`📋 **Task acknowledged:** ${prompt.substring(0, 100)} — est. ~${eta}`);
      }
      break;

    case "agent_started":
      // Background agent loop spawned by orchestrator
      console.log(`[Agent] Task started: "${message.payload.taskName || message.payload.taskId}" (${message.payload.personaId})`);
      // Forward to Discord #logs channel
      sendToLogsChannel(`▶️ **Task started:** ${message.payload.taskName || message.payload.taskId} (${message.payload.personaId})`);
      break;

    case "agent_complete":
      // Route to Discord #conversation if this was a Discord-originated prompt
      await handleDiscordResponse(message);
      // Always log locally too
      console.log(`[Agent] Task completed: ${message.payload.taskId} (${message.payload.success ? "success" : "failed"})`);
      // Forward completion summary to Discord #logs channel
      sendToLogsChannel(`${message.payload.success ? "✅" : "❌"} **Task ${message.payload.success ? "completed" : "failed"}:** ${message.payload.taskId}`);
      break;

    case "save_agent_work":
      // Persist agent work thread entry to disk
      if (message.payload?.agentTaskId && message.payload?.entry) {
        await appendAgentWork(message.payload.agentTaskId, message.payload.entry);
      }
      break;

    case "run_log":
      // Persist execution trace to disk for diagnostics
      await handleRunLog(message.payload);
      break;

    case "pong":
      // Heartbeat response
      break;
  }
}

// ============================================
// RUN LOG PERSISTENCE
// ============================================

const RUN_LOGS_DIR = path.join(DOTBOT_DIR, "run-logs");
const RUN_LOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

async function handleRunLog(payload: any): Promise<void> {
  try {
    await fs.mkdir(RUN_LOGS_DIR, { recursive: true });

    // Filename: timestamp_sessionId.json (sortable, unique)
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const sessionId = (payload.sessionId || "unknown").substring(0, 20);
    const filename = `${ts}_${sessionId}.json`;

    await fs.writeFile(
      path.join(RUN_LOGS_DIR, filename),
      JSON.stringify(payload, null, 2),
      "utf-8"
    );

    // Auto-prune: delete files older than 14 days
    const now = Date.now();
    const files = await fs.readdir(RUN_LOGS_DIR);
    for (const f of files) {
      try {
        const stat = await fs.stat(path.join(RUN_LOGS_DIR, f));
        if (now - stat.mtimeMs > RUN_LOG_MAX_AGE_MS) {
          await fs.unlink(path.join(RUN_LOGS_DIR, f));
        }
      } catch { /* skip files that vanish mid-scan */ }
    }
  } catch (error) {
    console.error("[Agent] Failed to save run log:", error);
  }
}

// ============================================
// HEARTBEAT
// ============================================

setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN) {
    send({
      type: "ping",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {}
    });
  }
}, 30000);

// ============================================
// MEMORY STATUS
// ============================================

async function showMemoryStatus(): Promise<void> {
  try {
    const memIndex = await memory.getMemoryIndex();
    const skills = await memory.getAllSkills();
    
    console.log("\n[Memory Status]");
    console.log(`  Mental Models: ${memIndex.models.length}`);
    console.log(`  Schemas: ${memIndex.schemas.length}`);
    console.log(`  Skills: ${skills.length}`);
    
    if (memIndex.models.length > 0) {
      console.log("\n  Recent Models:");
      const recent = memIndex.models
        .sort((a: memory.MentalModelIndexEntry, b: memory.MentalModelIndexEntry) => new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime())
        .slice(0, 5);
      for (const m of recent) {
        console.log(`    - ${m.name} (${m.category}) - ${m.beliefCount} beliefs, ${m.openLoopCount} open loops`);
      }
    }
    
    if (skills.length > 0) {
      console.log("\n  Skills:");
      for (const s of skills.slice(0, 5)) {
        console.log(`    - /${s.name} — ${s.description.substring(0, 60)}${s.description.length > 60 ? "..." : ""}`);
      }
    }
    console.log("");
  } catch (error) {
    console.error("[Agent] Failed to get memory status:", error);
  }
}

// ============================================
// CLI INTERFACE
// ============================================

const readline = await import("readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function promptUser(): void {
  rl.question("\n> ", (input) => {
    const trimmed = input.trim();
    
    if (trimmed === "quit" || trimmed === "exit") {
      console.log("[Agent] Goodbye!");
      process.exit(0);
    }
    
    if (trimmed === "status") {
      console.log(`[Agent] Connection: ${ws?.readyState === WebSocket.OPEN ? "Connected" : "Disconnected"}`);
      console.log(`[Agent] Device: ${DEVICE_NAME} (${deviceCredentials?.deviceId ?? "unregistered"})`);
      promptUser();
      return;
    }
    
    if (trimmed === "memory") {
      showMemoryStatus();
      promptUser();
      return;
    }
    
    if (trimmed) {
      // Run local LLM pre-classification, then send prompt to server
      import("./llm/prompt-classifier.js").then(({ classifyPromptLocally }) =>
        classifyPromptLocally(trimmed).then(hints => {
          send({
            type: "prompt",
            id: nanoid(),
            timestamp: Date.now(),
            payload: { prompt: trimmed, hints }
          });
        })
      ).catch(() => {
        // Fallback: send without hints if classifier import fails
        send({
          type: "prompt",
          id: nanoid(),
          timestamp: Date.now(),
          payload: { prompt: trimmed }
        });
      });
    }
    
    promptUser();
  });
}

// ============================================
// STARTUP
// ============================================

async function startup(): Promise<void> {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║   🖥️  DotBot Local Agent                           ║
║                                                       ║
║   Your PC, Cloud-powered intelligence.                ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝

Device: ${DEVICE_NAME}
ID: ${deviceCredentials?.deviceId ?? "unregistered"}
Server: ${SERVER_URL}
`);

  // Initialize local memory store
  console.log("[Agent] Initializing local memory store...");
  try {
    await memory.initializeMemoryStore();
    console.log("[Agent] Memory store ready.");
    
    // Bootstrap default council + personas (Skill Building Team)
    await memory.bootstrapInitialData();

    // Bootstrap agent identity (me.json) if it doesn't exist
    await memory.bootstrapIdentity();

    // Probe local LLM (non-blocking — just checks if model is downloaded)
    try {
      const { probeLocalModel } = await import("./llm/local-llm.js");
      await probeLocalModel();
    } catch (err) {
      console.log("[Agent] Local LLM probe skipped:", err instanceof Error ? err.message : err);
    }
    
    // Bootstrap knowledge files for personas that have them
    const { knowledgeCreated } = await memory.bootstrapDefaults();
    if (knowledgeCreated > 0) {
      console.log(`[Agent] Created ${knowledgeCreated} knowledge documents in ~/.bot/`);
    }

    // Bootstrap default skills (SKILL.md directories)
    const skillsCreated = await memory.bootstrapDefaultSkills();
    if (skillsCreated > 0) {
      console.log(`[Agent] Created ${skillsCreated} default skills in ~/.bot/skills/`);
    }

    // Validate all persona + council files and rebuild indexes from disk
    const validationResult = await memory.runStartupValidation();
    memory.printValidationReport(validationResult);

    // If malformed files found, ask user whether to attempt AI correction
    if (validationResult.malformedFiles.length > 0) {
      const answer = await new Promise<string>(resolve => {
        rl.question(
          `\nWould you like AI to attempt to correct ${validationResult.malformedFiles.length} malformed file(s) after connecting? (y/n): `,
          resolve
        );
      });
      if (answer.toLowerCase().startsWith("y")) {
        pendingFormatFixes = validationResult.malformedFiles;
        console.log("[Validator] Will attempt AI correction after server connection.");
      } else {
        console.log("[Validator] Malformed files were left out. Fix them manually and restart.");
      }
    }

    // Initialize tool registry
    console.log("[Agent] Initializing tool registry...");
    await initToolRegistry();

    // Ensure Playwright Chromium is installed (auto-downloads if missing)
    try {
      const { ensurePlaywrightBrowser } = await import("./tools/gui/ensure-browser.js");
      await ensurePlaywrightBrowser();
    } catch (err) {
      console.log("[Agent] Playwright browser check skipped:", err instanceof Error ? err.message : err);
    }

    // Tesseract OCR: NOT installed at startup. If DotBot needs OCR (Tier 2/3)
    // and Tesseract isn't found, the tool returns a clear error. DotBot can then
    // install it herself using shell.powershell — she has full computer access.
  } catch (error) {
    console.error("[Agent] Failed to initialize memory store:", error);
    console.log("[Agent] Continuing without persistent memory.");
  }

  console.log(`
Commands:
  - Type anything to send to the AI
  - 'status' - Check connection status  
  - 'memory' - View memory status
  - 'quit' - Exit the agent
`);

  connect();

  // Clean shutdown: stop background systems + kill Python daemon on exit
  const cleanup = () => {
    stopPeriodicManager();
    stopHeartbeat();
    stopSleepCycle();
    stopDiscordAdapter();
    import("./tools/gui/python-bridge.js")
      .then(({ shutdownDaemon }) => shutdownDaemon())
      .catch(() => {});
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  // Wait for connection before showing prompt
  setTimeout(() => {
    promptUser();
  }, 1000);
}

startup();
