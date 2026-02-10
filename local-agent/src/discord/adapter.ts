/**
 * Discord Adapter — Bridge Between Discord and DotBot
 * 
 * Responsibilities:
 * 1. Resolve the bot token via credential_resolve (held in memory only)
 * 2. Start the Discord Gateway client
 * 3. Filter incoming messages (Layer 1: authorized user ID)
 * 4. Forward valid messages as prompts to the DotBot server
 * 5. Intercept responses for Discord-originated prompts
 * 6. Send responses back to Discord via REST API (credential proxy)
 * 
 * Architecture: Discord Gateway ←→ Local Agent ←→ DotBot Server
 */

import { nanoid } from "nanoid";
import { DiscordGateway } from "./gateway.js";
import type { DiscordMessage, DiscordInteraction } from "./gateway.js";
import { resolveCredential } from "../credential-proxy.js";
import { credentialProxyFetch } from "../credential-proxy.js";
import { vaultHas } from "../credential-vault.js";
import { classifyPromptLocally } from "../llm/prompt-classifier.js";
import type { WSMessage } from "../types.js";

// ============================================
// CONSTANTS
// ============================================

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_CREDENTIAL_NAME = "DISCORD_BOT_TOKEN";

// Discord message length limit
const DISCORD_MAX_LENGTH = 2000;

// ============================================
// STATE
// ============================================

let gateway: DiscordGateway | null = null;
let botUserId: string | null = null;
let wsSend: ((message: WSMessage) => void) | null = null;

// Layer 1: Authorized user ID
let authorizedUserId: string | null = null;

// Response tracking: prompt message ID → Discord channel ID
const pendingDiscordResponses = new Map<string, {
  channelId: string;
  discordMessageId: string;
  taskId?: string;
}>();

// Typing indicator interval per channel
const typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

// Pending response timeout (clean up stale entries after 10 minutes)
const PENDING_RESPONSE_TTL_MS = 10 * 60 * 1000;

// ============================================
// INITIALIZATION
// ============================================

/**
 * Initialize the Discord adapter.
 * Resolves the bot token, connects to Gateway, and starts listening.
 * 
 * @param send - Function to send WSMessage to the DotBot server
 */
export async function initDiscordAdapter(send: (message: WSMessage) => void): Promise<void> {
  wsSend = send;

  // Check if Discord is configured
  const hasToken = await vaultHas(DISCORD_CREDENTIAL_NAME);
  const conversationChannelId = process.env.DISCORD_CHANNEL_CONVERSATION;

  console.log(`[Discord] Init check: hasToken=${hasToken}, channelId=${conversationChannelId ? 'SET' : 'MISSING'}`);

  if (!hasToken || !conversationChannelId) {
    console.log("[Discord] Not configured — skipping adapter init. Run /discord-setup first.");
    return;
  }

  // Guard: if already running (e.g. WS reconnect triggered auth_success again),
  // don't create a second Gateway — that causes duplicate message processing.
  if (gateway) {
    console.log("[Discord] Adapter already running — updating send function only");
    return;
  }

  // Load authorized user ID from env
  authorizedUserId = process.env.DISCORD_AUTHORIZED_USER_ID || null;

  try {
    // Resolve the bot token (held in memory only, never logged)
    console.log("[Discord] Requesting token resolve from server...");
    const token = await resolveCredential(DISCORD_CREDENTIAL_NAME, "discord_gateway");

    console.log(`[Discord] Token resolved (${token.length} chars) — connecting to Gateway...`);

    gateway = new DiscordGateway(token, {
      onMessage: handleDiscordMessage,
      onInteraction: handleDiscordInteraction,
      onReady: (userId) => {
        botUserId = userId;
        console.log(`[Discord] Bot online — listening on #conversation`);

        if (!authorizedUserId) {
          console.log("[Discord] ⚠️ No DISCORD_AUTHORIZED_USER_ID set — will authorize first human message");
        }
      },
      onDisconnect: () => {
        console.log("[Discord] Gateway disconnected — will reconnect automatically");
      },
      onError: (error) => {
        console.error(`[Discord] Gateway error: ${error}`);
        handleGatewayError(error);
      },
    });

    gateway.connect();
  } catch (err: any) {
    console.error(`[Discord] Failed to initialize: ${err.message}`);
  }
}

/**
 * Shut down the Discord adapter gracefully.
 */
export function stopDiscordAdapter(): void {
  // Clear all typing intervals
  for (const [channelId] of typingIntervals) {
    stopTyping(channelId);
  }
  if (gateway) {
    gateway.disconnect();
    gateway = null;
    console.log("[Discord] Adapter stopped");
  }
}

/**
 * Check if the Discord adapter is running.
 */
export function isDiscordAdapterRunning(): boolean {
  return gateway !== null;
}

// ============================================
// INCOMING: Discord → DotBot
// ============================================

async function handleDiscordMessage(message: DiscordMessage): Promise<void> {
  // Ignore bot messages (including our own)
  if (message.author.bot) return;

  // Only process messages in #conversation
  const conversationChannelId = process.env.DISCORD_CHANNEL_CONVERSATION;
  if (!conversationChannelId || message.channel_id !== conversationChannelId) return;

  // Ignore empty messages
  if (!message.content.trim()) return;

  // ── Layer 1: Authorized User ID ──
  if (!authorizedUserId) {
    // First human message — auto-authorize this user
    authorizedUserId = message.author.id;
    process.env.DISCORD_AUTHORIZED_USER_ID = authorizedUserId;
    console.log(`[Discord] Authorized user: ${message.author.username} (${authorizedUserId})`);
    persistAuthorizedUser(authorizedUserId);
  }

  if (message.author.id !== authorizedUserId) {
    console.log(`[Discord] Ignored message from unauthorized user: ${message.author.username} (${message.author.id})`);
    return;
  }

  // Forward as prompt to DotBot server
  const promptId = `discord_${nanoid()}`;

  pendingDiscordResponses.set(promptId, {
    channelId: message.channel_id,
    discordMessageId: message.id,
  });

  // Auto-cleanup stale pending entries to prevent memory leaks
  setTimeout(() => {
    if (pendingDiscordResponses.has(promptId)) {
      pendingDiscordResponses.delete(promptId);
      stopTyping(message.channel_id);
    }
  }, PENDING_RESPONSE_TTL_MS);

  console.log(`[Discord] → Prompt from ${message.author.username}: ${message.content.substring(0, 80)}${message.content.length > 80 ? "..." : ""}`);

  // Start typing indicator while we process
  startTypingLoop(message.channel_id);

  if (wsSend) {
    // Run local LLM pre-classification (fast, on-device)
    const hints = await classifyPromptLocally(message.content);
    wsSend({
      type: "prompt",
      id: promptId,
      timestamp: Date.now(),
      payload: {
        prompt: message.content,
        source: "discord",
        sourceUserId: message.author.id,
        hints,
      },
    });
  }
}

// ============================================
// OUTGOING: DotBot → Discord
// ============================================

/**
 * Handle a response from the DotBot server.
 * If it matches a Discord-originated prompt, send it to Discord.
 * Returns true if the message was handled (consumed), false otherwise.
 */
export function handleDiscordResponse(message: WSMessage): boolean {
  if (!gateway) return false;

  switch (message.type) {
    case "response": {
      const pending = pendingDiscordResponses.get(message.id);
      if (!pending) return false;

      const payload = message.payload;

      // Check if this is a background task ack (has agentTaskId)
      if (payload.agentTaskId) {
        // Track the task ID so we can match the agent_complete later
        pending.taskId = payload.agentTaskId;
        pendingDiscordResponses.set(message.id, pending);

        // Also track by task ID for agent_complete lookup
        pendingDiscordResponses.set(`task_${payload.agentTaskId}`, {
          channelId: pending.channelId,
          discordMessageId: pending.discordMessageId,
          taskId: payload.agentTaskId,
        });

        // Don't send the ack to Discord — the typing indicator is sufficient.
        // Only the final agent_complete result gets sent to avoid duplicate messages.
        return true;
      }

      // Routing acks (injection, status query, resume) — suppress on Discord.
      // These are system noise; the user only needs the final result.
      if (payload.isRoutingAck) {
        pendingDiscordResponses.delete(message.id);
        return true;
      }

      // Inline response — send to Discord and clean up
      pendingDiscordResponses.delete(message.id);
      stopTyping(pending.channelId);
      if (payload.response) {
        sendToDiscord(pending.channelId, payload.response);
      }
      return true;
    }

    case "agent_complete": {
      const taskId = message.payload?.taskId;
      if (!taskId) return false;

      const pending = pendingDiscordResponses.get(`task_${taskId}`);
      if (!pending) return false;

      // Stop typing indicator
      stopTyping(pending.channelId);

      // Clean up both entries
      pendingDiscordResponses.delete(`task_${taskId}`);
      // Find and clean up the original prompt entry too
      for (const [key, val] of pendingDiscordResponses) {
        if (val.taskId === taskId && key !== `task_${taskId}`) {
          pendingDiscordResponses.delete(key);
          break;
        }
      }

      if (message.payload.response) {
        sendToDiscord(pending.channelId, message.payload.response);
      }
      return true;
    }

    case "task_progress": {
      // Don't forward tool progress to Discord — the typing indicator is sufficient.
      // Individual tool call messages are too noisy and clutter the conversation.
      const taskId = message.payload?.taskId;
      if (!taskId) return false;
      const pending = pendingDiscordResponses.get(`task_${taskId}`);
      return !!pending; // Consume silently if this is a Discord-originated task
    }

    default:
      return false;
  }
}

// ============================================
// GATEWAY ERROR HANDLING
// ============================================

function handleGatewayError(error: string): void {
  const isIntentError = error.toLowerCase().includes("intent");

  if (isIntentError) {
    const channelId = process.env.DISCORD_CHANNEL_CONVERSATION;
    const message = [
      "⚠️ **Discord Gateway: Message Content Intent is not enabled**",
      "",
      "I can't read your messages until you enable it:",
      "",
      "1. Go to https://discord.com/developers/applications",
      "2. Select your **DotBot** application",
      "3. Click **Bot** in the left sidebar",
      "4. Scroll to **Privileged Gateway Intents**",
      "5. Turn on **MESSAGE CONTENT INTENT**",
      "6. Click **Save Changes**",
      "",
      "Then restart the agent (`system.restart` or re-run `run-dev.bat`).",
    ].join("\n");

    // Notify via Discord REST (works without Gateway)
    if (channelId) {
      sendToDiscord(channelId, message).catch(() => {});
    }

    // Notify via DotBot client — include suggested fix action
    if (wsSend) {
      wsSend({
        type: "user_notification",
        id: `discord_intent_${Date.now()}`,
        timestamp: Date.now(),
        payload: {
          title: "Discord: Message Content Intent Required",
          message: "The bot connected but Discord rejected the Message Content Intent. Enable it in Developer Portal → Bot → Privileged Gateway Intents → MESSAGE CONTENT INTENT, then restart.",
          source: "discord",
          suggestedPrompt: "The Discord Message Content Intent is not enabled and I can't fix it from the API. Can you try to enable it for me using computer mode (GUI automation)? Go to https://discord.com/developers/applications, select the DotBot app, click Bot, scroll to Privileged Gateway Intents, toggle MESSAGE CONTENT INTENT on, and click Save Changes. This is experimental so let me know if it doesn't work.",
          suggestedLabel: "\ud83d\udda5\ufe0f Try to fix with Computer Mode (experimental)",
        },
      });
    }
  }
}

// ============================================
// TYPING INDICATOR
// ============================================

async function triggerTyping(channelId: string): Promise<void> {
  try {
    await credentialProxyFetch(`/channels/${channelId}/typing`, DISCORD_CREDENTIAL_NAME, {
      baseUrl: DISCORD_API,
      method: "POST",
      headers: {
        "User-Agent": "DotBot (https://getmy.bot, 1.0)",
      },
      placement: { header: "Authorization", prefix: "Bot " },
    });
  } catch {
    // Non-fatal — typing indicator is cosmetic
  }
}

function startTypingLoop(channelId: string): void {
  stopTyping(channelId);
  triggerTyping(channelId);
  // Discord typing indicator lasts ~10s, re-trigger every 8s
  const interval = setInterval(() => triggerTyping(channelId), 8_000);
  typingIntervals.set(channelId, interval);
}

function stopTyping(channelId: string): void {
  const interval = typingIntervals.get(channelId);
  if (interval) {
    clearInterval(interval);
    typingIntervals.delete(channelId);
  }
}

// ============================================
// DISCORD REST API (via credential proxy)
// ============================================

async function sendToDiscord(channelId: string, content: string): Promise<void> {
  try {
    // Sanitize: prevent @everyone/@here pings from LLM output
    const sanitized = content.replace(/@(everyone|here)/g, "@\u200b$1");
    // Split long messages
    const chunks = splitMessage(sanitized);
    for (const chunk of chunks) {
      await credentialProxyFetch(`/channels/${channelId}/messages`, DISCORD_CREDENTIAL_NAME, {
        baseUrl: DISCORD_API,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "DotBot (https://getmy.bot, 1.0)",
        },
        body: JSON.stringify({ content: chunk }),
        placement: { header: "Authorization", prefix: "Bot " },
      });
    }
  } catch (err: any) {
    console.error(`[Discord] Failed to send message: ${err.message}`);
  }
}

function splitMessage(content: string): string[] {
  if (content.length <= DISCORD_MAX_LENGTH) return [content];

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitIdx = remaining.lastIndexOf("\n", DISCORD_MAX_LENGTH);
    if (splitIdx < DISCORD_MAX_LENGTH * 0.5) {
      // No good newline — split at space
      splitIdx = remaining.lastIndexOf(" ", DISCORD_MAX_LENGTH);
    }
    if (splitIdx <= 0) {
      // No good split point — hard split at limit
      splitIdx = DISCORD_MAX_LENGTH;
    }

    chunks.push(remaining.substring(0, splitIdx));
    remaining = remaining.substring(splitIdx).trimStart();
  }

  return chunks;
}

// ============================================
// CHANNEL ROUTING — #updates and #logs
// ============================================

/**
 * Send a notification/update to the #updates channel.
 * Used for: user_notification, heartbeat alerts, agent completions.
 * Silently no-ops if Discord is not configured or #updates channel not set.
 */
export async function sendToUpdatesChannel(content: string): Promise<void> {
  if (!gateway) return;
  const channelId = process.env.DISCORD_CHANNEL_UPDATES;
  if (!channelId) return;
  await sendToDiscord(channelId, content);
}

/**
 * Send a log entry to the #logs channel.
 * Used for: agent_started, run_log summaries, errors.
 * Silently no-ops if Discord is not configured or #logs channel not set.
 */
export async function sendToLogsChannel(content: string): Promise<void> {
  if (!gateway) return;
  const channelId = process.env.DISCORD_CHANNEL_LOGS;
  if (!channelId) return;
  await sendToDiscord(channelId, content);
}

// ============================================
// INTERACTION HANDLING (Button clicks)
// ============================================

// Registered interaction handlers: custom_id prefix → handler function
const interactionHandlers = new Map<string, (interaction: DiscordInteraction, args: string) => Promise<void>>();

/**
 * Register a handler for button interactions with a given custom_id prefix.
 * Example: registerInteraction("confirm", handler) catches custom_id="confirm:payload".
 */
export function registerInteraction(
  prefix: string,
  handler: (interaction: DiscordInteraction, args: string) => Promise<void>,
): void {
  interactionHandlers.set(prefix, handler);
}

async function handleDiscordInteraction(interaction: DiscordInteraction): Promise<void> {
  // Only handle authorized users
  if (authorizedUserId && interaction.user.id !== authorizedUserId) {
    await ackInteraction(interaction, "You're not authorized to use these buttons.", true);
    return;
  }

  const customId = interaction.data.custom_id;
  console.log(`[Discord] Button clicked: custom_id="${customId}" by ${interaction.user.username}`);

  // Parse prefix:args pattern
  const colonIdx = customId.indexOf(":");
  const prefix = colonIdx >= 0 ? customId.substring(0, colonIdx) : customId;
  const args = colonIdx >= 0 ? customId.substring(colonIdx + 1) : "";

  const handler = interactionHandlers.get(prefix);
  if (handler) {
    try {
      await handler(interaction, args);
    } catch (err: any) {
      console.error(`[Discord] Interaction handler error (${prefix}):`, err.message);
      await ackInteraction(interaction, `Error: ${err.message}`, true);
    }
    return;
  }

  // Default: if custom_id starts with "prompt:", forward as a DotBot prompt
  if (prefix === "prompt") {
    await deferInteraction(interaction);
    const promptText = args || customId;
    const promptId = `discord_btn_${nanoid()}`;

    pendingDiscordResponses.set(promptId, {
      channelId: interaction.channel_id,
      discordMessageId: interaction.message?.id || "",
    });

    startTypingLoop(interaction.channel_id);

    if (wsSend) {
      const hints = await classifyPromptLocally(promptText);
      wsSend({
        type: "prompt",
        id: promptId,
        timestamp: Date.now(),
        payload: {
          prompt: promptText,
          source: "discord_button",
          sourceUserId: interaction.user.id,
          hints,
        },
      });
    }
    return;
  }

  // Unknown button — ACK with ephemeral message
  await ackInteraction(interaction, "This button isn't connected to any action.", true);
}

/**
 * ACK an interaction with an immediate message response.
 * Set ephemeral=true to make the response visible only to the clicker.
 */
export async function ackInteraction(
  interaction: DiscordInteraction,
  content: string,
  ephemeral = false,
): Promise<void> {
  try {
    await credentialProxyFetch(
      `/interactions/${interaction.id}/${interaction.token}/callback`,
      DISCORD_CREDENTIAL_NAME,
      {
        baseUrl: DISCORD_API,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "DotBot (https://getmy.bot, 1.0)",
        },
        body: JSON.stringify({
          type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
          data: {
            content,
            flags: ephemeral ? 64 : 0, // 64 = EPHEMERAL
          },
        }),
        placement: { header: "Authorization", prefix: "Bot " },
      },
    );
  } catch (err: any) {
    console.error(`[Discord] Failed to ACK interaction: ${err.message}`);
  }
}

/**
 * Defer an interaction (show "thinking..." indicator).
 * Follow up later with followUpInteraction().
 */
export async function deferInteraction(interaction: DiscordInteraction): Promise<void> {
  try {
    await credentialProxyFetch(
      `/interactions/${interaction.id}/${interaction.token}/callback`,
      DISCORD_CREDENTIAL_NAME,
      {
        baseUrl: DISCORD_API,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "DotBot (https://getmy.bot, 1.0)",
        },
        body: JSON.stringify({
          type: 5, // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
        }),
        placement: { header: "Authorization", prefix: "Bot " },
      },
    );
  } catch (err: any) {
    console.error(`[Discord] Failed to defer interaction: ${err.message}`);
  }
}

/**
 * Send a follow-up message after a deferred interaction.
 */
export async function followUpInteraction(
  interaction: DiscordInteraction,
  content: string,
): Promise<void> {
  try {
    await credentialProxyFetch(
      `/webhooks/${botUserId}/${interaction.token}`,
      DISCORD_CREDENTIAL_NAME,
      {
        baseUrl: DISCORD_API,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "DotBot (https://getmy.bot, 1.0)",
        },
        body: JSON.stringify({ content }),
        placement: { header: "Authorization", prefix: "Bot " },
      },
    );
  } catch (err: any) {
    console.error(`[Discord] Failed to follow up interaction: ${err.message}`);
  }
}

// ============================================
// PERSISTENCE
// ============================================

async function persistAuthorizedUser(userId: string): Promise<void> {
  try {
    const { promises: fs } = await import("fs");
    const { resolve } = await import("path");
    const envPath = resolve(process.env.USERPROFILE || process.env.HOME || "", ".bot", ".env");

    let existing = "";
    try {
      existing = await fs.readFile(envPath, "utf-8");
    } catch { /* file doesn't exist */ }

    // Parse existing .env
    const envMap = new Map<string, string>();
    for (const line of existing.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        envMap.set(trimmed.substring(0, eqIdx).trim(), trimmed.substring(eqIdx + 1).trim());
      }
    }

    envMap.set("DISCORD_AUTHORIZED_USER_ID", userId);

    const lines = Array.from(envMap.entries()).map(([k, v]) => `${k}=${v}`);
    await fs.writeFile(envPath, lines.join("\n") + "\n", "utf-8");

    console.log(`[Discord] Saved authorized user ID to ~/.bot/.env`);
  } catch (err: any) {
    console.error(`[Discord] Failed to persist authorized user: ${err.message}`);
  }
}
