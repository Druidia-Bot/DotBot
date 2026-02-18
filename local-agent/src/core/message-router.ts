/**
 * Message Router — Dispatches incoming WebSocket messages to handlers.
 *
 * Thin switch statement that delegates to specialized handler modules.
 * No business logic lives here — just routing.
 */

import { nanoid } from "nanoid";
import type { WSMessage } from "../types.js";
import { AGENT_VERSION, DEVICE_NAME, SERVER_URL, deviceCredentials, setDeviceCredentials } from "./config.js";
import { send, handlePendingResponse, handlePong } from "./ws-client.js";
import { cleanConsumedInviteToken } from "./env.js";
import { initializeAfterAuth, notifyActivity } from "./post-auth-init.js";
import { writeClientLog } from "./client-log.js";
import { saveDeviceCredentials } from "../auth/device-credentials.js";
import { appendAgentWork } from "../memory/store-agent-work.js";

// Extracted handlers
import { handleMemoryRequest, handleSkillRequest } from "../handlers/memory-handlers.js";
import { handlePersonaRequest, handleCouncilRequest, handleKnowledgeRequest, handleKnowledgeQuery, handleToolRequest } from "../handlers/discovery-handlers.js";
import {
  handleExecutionRequest, handleSchemaRequest,
  handleThreadRequest, handleThreadUpdate, handleSaveToThread,
  handleStoreAsset, handleRetrieveAsset, handleCleanupAssets,
} from "../handlers/resource-handlers.js";
import {
  handleProxyResponse,
  handleSessionReady,
  handleCredentialStored,
  handleResolveResponse,
} from "../credential-proxy.js";
import { handleServerLLMResponse } from "../server-llm.js";
import { handleDiscordResponse, sendToConversationChannel, sendToUpdatesChannel, sendToLogsChannel } from "../discord/adapter.js";
import { vaultSetServerBlob } from "../credential-vault.js";
import type { MalformedFile } from "../memory/startup-validator.js";

let pendingFormatFixes: MalformedFile[] = [];
let authInitialized = false;

export function setPendingFormatFixes(fixes: MalformedFile[]): void {
  pendingFormatFixes = fixes;
}

export async function handleMessage(message: WSMessage): Promise<void> {
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
        setDeviceCredentials({
          deviceId,
          deviceSecret,
          serverUrl: SERVER_URL,
          registeredAt: new Date().toISOString(),
          label: DEVICE_NAME,
        });
        saveDeviceCredentials(deviceCredentials!);
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

        if (!authInitialized) {
          authInitialized = true;
          const fixes = pendingFormatFixes;
          pendingFormatFixes = [];
          await initializeAfterAuth(fixes);
        }
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

    case "dispatch_followup":
      // Pipeline completed — send Dot's summary to Discord conversation channel
      if (message.payload.response) {
        console.log("\n[Dispatch Followup]", message.payload.response);
        await sendToConversationChannel(message.payload.response);
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
        vaultSetServerBlob(stored.keyName, stored.blob).then(async () => {
          console.log(`[Agent] Credential "${stored.keyName}" stored securely (server-encrypted)`);

          // If the Discord bot token was updated, restart the gateway with the new token.
          // The gateway holds the old token in memory — it won't pick up the new one otherwise.
          if (stored.keyName === "DISCORD_BOT_TOKEN") {
            try {
              const { restartDiscordGateway } = await import("../discord/adapter.js");
              await restartDiscordGateway();
            } catch (err) {
              console.error("[Agent] Failed to restart Discord gateway after token update:", err);
            }
          }
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
      if (message.payload?.message && message.payload?.source !== "sleep_cycle") {
        if (message.payload?.source === "agent_lifecycle") {
          // Agent lifecycle events go to #updates + #logs only (not #conversation)
          const detail = message.payload.detail ? `\n${message.payload.detail}` : "";
          sendToUpdatesChannel(`🤖 ${message.payload.message}${detail}`);
          sendToLogsChannel(`🤖 **[${message.payload.event}]** ${message.payload.message}${detail}`);
        } else {
          // Other notification sources go to both #conversation and #updates
          sendToConversationChannel(`🔔 **${message.payload.title || "Notification"}**\n${message.payload.message}`);
          sendToUpdatesChannel(`🔔 **${message.payload.title || "Notification"}**\n${message.payload.message}`);
        }
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
      if (message.payload?.stage === "write_log") {
        // Generic log write — subfolder/filename/content provided by server
        await writeClientLog(message.payload);
      } else {
        // Legacy run-log — auto-wrap into daily JSONL with 72h pruning
        const now = new Date();
        const entry = JSON.stringify({ ...message.payload, _ts: now.toISOString() }) + "\n";
        await writeClientLog({
          subfolder: "run-logs",
          filename: `${now.toISOString().slice(0, 10)}.log`,
          content: entry,
          mode: "append",
          pruneAfterMs: 72 * 60 * 60 * 1000,
        });
      }
      break;

    case "system_update": {
      // Server pushed an update — agent version doesn't match server version
      const { serverVersion, agentVersion, reason } = message.payload;
      console.log(`[Agent] Server pushed update: ${reason}`);
      console.log(`[Agent]   Server: ${serverVersion}, Agent: ${AGENT_VERSION}`);
      sendToUpdatesChannel(`🔄 **Auto-update triggered** — server is on v${serverVersion}, agent is on v${agentVersion}. Updating now...`);
      sendToLogsChannel(`🔄 Server pushed system_update: ${reason}`);

      // Trigger the same update flow as system.update tool
      // Import dynamically to avoid circular dependency
      import("../tools/system/handler.js").then(async ({ handleSystem }) => {
        const result = await handleSystem("system.update", { reason: `Server-pushed: ${reason}` });
        if (!result.success) {
          console.error(`[Agent] Server-pushed update failed: ${result.error}`);
          sendToUpdatesChannel(`❌ **Auto-update failed:** ${result.error}`);
        }
        // handleSystem("system.update") already calls process.exit(42) on success
      }).catch(err => {
        console.error("[Agent] Failed to run server-pushed update:", err);
        sendToUpdatesChannel(`❌ **Auto-update failed:** ${err instanceof Error ? err.message : String(err)}`);
      });
      break;
    }

    case "pong":
      handlePong();
      break;
  }
}
