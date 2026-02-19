/**
 * Post-Auth Initialization — Everything that runs after successful authentication.
 *
 * Extracted from the massive auth_success block in index.ts.
 * Wires up: credential proxy, server LLM, admin tools, restart queue,
 * sleep cycle, heartbeat, reminders, onboarding, periodic manager, Discord.
 */

import { nanoid } from "nanoid";
import { promises as fs } from "fs";
import WebSocket from "ws";
import type { WSMessage } from "../types.js";
import { SERVER_URL, DEVICE_NAME, deviceCredentials } from "./config.js";
import { send, sendAndWaitForResponse, getWs } from "./ws-client.js";
import { RESTART_QUEUE_PATH, resubmitRestartQueue } from "./restart-queue.js";
import { startSetupServer } from "../setup-server.js";
import { initCredentialProxy } from "../credential-proxy.js";
import { initServerLLM } from "../server-llm.js";
import { setAdminRequestSender } from "../tools/admin/handler.js";
import { setPreRestartHook } from "../tools/tool-executor.js";
import { initSleepCycle, setSleepCycleLoopCallback, getPeriodicTaskDef as getSleepCycleTaskDef } from "../memory/sleep-cycle.js";
import { initHeartbeat, getPeriodicTaskDef as getHeartbeatTaskDef } from "../heartbeat/heartbeat.js";
import { startPeriodicManager, notifyActivity } from "../periodic/index.js";
import { setReminderNotifyCallback, getPeriodicTaskDef as getReminderTaskDef } from "../reminders/checker.js";
import { setOnboardingNotifyCallback, setOnboardingDiscordCallback, setOnboardingSendPromptCallback, getPeriodicTaskDef as getOnboardingTaskDef } from "../onboarding/checker.js";
import { onboardingExists, initOnboarding } from "../onboarding/store.js";
import { setUpdateNotifyCallback, getPeriodicTaskDef as getUpdateCheckTaskDef } from "../onboarding/update-checker.js";
import { initDiscordAdapter, sendToConversationChannel, sendToUpdatesChannel } from "../discord/adapter.js";
import { processFormatFixes } from "../handlers/format-fixer.js";
import { getServerSideConfigs } from "../tools/mcp/index.js";
import { vaultGetBlob } from "../credential-vault.js";
import type { MalformedFile } from "../memory/startup-validator.js";

export { notifyActivity };

/**
 * Re-send credentialed MCP configs to the server.
 * Called on EVERY successful auth (including WS reconnects) because
 * the server clears blobs on disconnect. Safe to call multiple times —
 * the server debounces initMcpForDevice.
 */
export async function resendMcpConfigs(): Promise<void> {
  const serverMcpConfigs = getServerSideConfigs();
  if (serverMcpConfigs.length === 0) return;

  const credentialBlobs: Record<string, string> = {};
  for (const config of serverMcpConfigs) {
    if (config.credentialRequired) {
      const blob = await vaultGetBlob(config.credentialRequired);
      if (blob) credentialBlobs[config.credentialRequired] = blob;
    }
  }
  send({
    type: "mcp_configs",
    id: nanoid(),
    timestamp: Date.now(),
    payload: { configs: serverMcpConfigs, credentialBlobs },
  });
  console.log(`[MCP] Re-sent ${serverMcpConfigs.length} credentialed config(s) to server`);
}

let setupServerStarted = false;

/**
 * Run all post-authentication initialization.
 * Called once after first successful auth or device_registered.
 */
export async function initializeAfterAuth(
  pendingFormatFixes: MalformedFile[],
): Promise<void> {
  // Start local setup server for secure browser authentication (once only)
  if (!setupServerStarted) {
    const setupDeviceId = deviceCredentials?.deviceId;
    const setupDeviceSecret = deviceCredentials?.deviceSecret;
    if (setupDeviceId && setupDeviceSecret) {
      const httpUrl = SERVER_URL
        .replace(/^wss?:\/\//, (match) => match === 'wss://' ? 'https://' : 'http://')
        .replace(/\/ws\/?$/, '');

      try {
        const { port, setupCode } = startSetupServer(
          setupDeviceId,
          setupDeviceSecret,
          httpUrl
        );
        setupServerStarted = true;

        const setupUrl = `http://localhost:${port}/setup?code=${setupCode}`;
        console.log("");
        console.log("╔════════════════════════════════════════════════════════╗");
        console.log("║                                                        ║");
        console.log("║  🌐 Opening Browser...                                 ║");
        console.log("║                                                        ║");
        console.log(`║  ${setupUrl}                                           ║`);
        console.log("║                                                        ║");
        console.log("╚════════════════════════════════════════════════════════╝");
        console.log("");

        // Auto-open the setup URL in the default browser
        import('child_process').then(({ exec }) => {
          exec(`start "" "${setupUrl}"`);
        }).catch(() => {});
      } catch (err) {
        console.warn("[Agent] Setup server failed to start:", err);
      }
    }
  }

  // Initialize subsystems with server sender
  initCredentialProxy(send);
  initServerLLM(send);

  // Send credentialed MCP configs to server (server connects with decrypted credentials)
  // Include encrypted vault blobs so the server can decrypt them internally
  const serverMcpConfigs = getServerSideConfigs();
  if (serverMcpConfigs.length > 0) {
    const credentialBlobs: Record<string, string> = {};
    for (const config of serverMcpConfigs) {
      if (config.credentialRequired) {
        const blob = await vaultGetBlob(config.credentialRequired);
        if (blob) credentialBlobs[config.credentialRequired] = blob;
      }
    }
    send({
      type: "mcp_configs",
      id: nanoid(),
      timestamp: Date.now(),
      payload: { configs: serverMcpConfigs, credentialBlobs },
    });
    console.log(`[MCP] Sent ${serverMcpConfigs.length} credentialed config(s) to server`);
  }

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
    const currentWs = getWs();
    const ackListener = (data: any) => {
      try {
        const msg: WSMessage = JSON.parse(data.toString());
        if (msg.type === "cancel_before_restart_ack") {
          currentWs?.off("message", ackListener);
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
    currentWs?.on("message", ackListener);

    // Timeout: don't wait forever
    const timer = setTimeout(() => {
      currentWs?.off("message", ackListener);
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
  resubmitRestartQueue(send, nanoid);

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

  // Wire reminder notifications → Discord #conversation + #updates
  setReminderNotifyCallback((reminder) => {
    const emoji = reminder.priority === "P0" ? "🚨" : "🔔";
    const msg = `${emoji} **Reminder:** ${reminder.message}`;
    sendToConversationChannel(msg);
    sendToUpdatesChannel(`${msg}\n_Scheduled for: ${reminder.scheduledFor}_`);
  });

  // Wire onboarding nag notifications → Dot's conversation + Discord #updates
  setOnboardingSendPromptCallback((message) => {
    send({
      type: "prompt",
      id: nanoid(),
      timestamp: Date.now(),
      payload: { prompt: message, source: "system" },
    });
  });
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

  // Start the unified periodic manager — each subsystem owns its own config
  startPeriodicManager([
    getHeartbeatTaskDef(),
    getReminderTaskDef(),
    getSleepCycleTaskDef(),
    getOnboardingTaskDef(),
    getUpdateCheckTaskDef(),
  ]);

  // Process pending format fixes if user opted in
  if (pendingFormatFixes.length > 0) {
    processFormatFixes(pendingFormatFixes, sendAndWaitForResponse).catch(err => {
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
