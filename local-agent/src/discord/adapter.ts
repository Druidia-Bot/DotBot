/**
 * Discord Adapter — Bridge Between Discord and DotBot
 *
 * Orchestrates the Discord integration lifecycle:
 * - Resolves the bot token and connects the Gateway
 * - Filters incoming messages (authorized user ID)
 * - Forwards valid messages as prompts to the DotBot server
 * - Delegates response routing to the response tracker
 *
 * Architecture: Discord Gateway <-> Local Agent <-> DotBot Server
 */

import { nanoid } from 'nanoid';
import { promises as fs } from 'fs';
import * as path from 'path';
import { DiscordGateway } from './gateway.js';
import type { DiscordMessage, DiscordAttachment } from './types.js';
import { sendToDiscord, startTypingLoop, clearAllTyping, deferInteraction, DISCORD_CREDENTIAL_NAME } from './rest.js';
import { registerInteraction, handleDiscordInteraction } from './interactions.js';
import { setChannelsActive } from './channels.js';
import { trackPending, clearAllPending, getPendingCount, routeResponse } from './response-tracker.js';
import { resolveCredential } from '../credential-proxy.js';
import { vaultHas } from '../credential-vault.js';
import { classifyPromptLocally } from '../llm/prompt-classifier.js';
import { TEMP_DIR } from '../memory/store-core.js';
import type { WSMessage } from '../types.js';

// Re-export for external consumers
export { registerInteraction } from './interactions.js';
export { ackInteraction, deferInteraction, followUpInteraction } from './rest.js';
export { sendToConversationChannel, sendToUpdatesChannel, sendToLogsChannel } from './channels.js';

// ============================================
// STATE
// ============================================

let gateway: DiscordGateway | null = null;
let botUserId: string | null = null;
let wsSend: ((message: WSMessage) => void) | null = null;
let authorizedUserId: string | null = null;

// ============================================
// LIFECYCLE
// ============================================

/**
 * Initialize the Discord adapter.
 * Resolves the bot token, connects to Gateway, and starts listening.
 */
export async function initDiscordAdapter(send: (message: WSMessage) => void): Promise<void> {
  wsSend = send;

  const hasToken = await vaultHas(DISCORD_CREDENTIAL_NAME);
  const conversationChannelId = process.env.DISCORD_CHANNEL_CONVERSATION;

  console.log(`[Discord] Init check: hasToken=${hasToken}, channelId=${conversationChannelId ? 'SET' : 'MISSING'}`);

  if (!hasToken || !conversationChannelId) {
    console.log('[Discord] Not configured — skipping adapter init. Run /discord-setup first.');
    return;
  }

  // Guard: if already running (e.g. WS reconnect triggered auth_success again),
  // don't create a second Gateway — that causes duplicate message processing.
  // But DO clear stale pending responses — the server lost all in-flight work on restart.
  if (gateway) {
    console.log('[Discord] Adapter already running — clearing stale state from previous session');
    const staleCount = clearAllPending();
    if (staleCount > 0) {
      console.log(`[Discord] Cleared ${staleCount} stale pending response(s) and typing indicators`);
    }
    return;
  }

  authorizedUserId = process.env.DISCORD_AUTHORIZED_USER_ID || null;
  registerPromptInteractionHandler();

  try {
    console.log('[Discord] Requesting token resolve from server...');
    const token = await resolveCredential(DISCORD_CREDENTIAL_NAME, 'discord_gateway');

    console.log(`[Discord] Token resolved (${token.length} chars) — connecting to Gateway...`);

    gateway = new DiscordGateway(token, {
      onMessage: handleDiscordMessage,
      onInteraction: (interaction) => handleDiscordInteraction(interaction, authorizedUserId),
      onReady: (userId) => {
        botUserId = userId;
        console.log('[Discord] Bot online — listening on #conversation');
        if (!authorizedUserId) {
          console.log('[Discord] \u26a0\ufe0f No DISCORD_AUTHORIZED_USER_ID set — will authorize first human message');
        }
      },
      onDisconnect: () => {
        console.log('[Discord] Gateway disconnected — will reconnect automatically');
      },
      onError: (error) => {
        console.error(`[Discord] Gateway error: ${error}`);
        handleGatewayError(error);
      },
    });

    setChannelsActive(true);
    gateway.connect();
  } catch (err: any) {
    console.error(`[Discord] Failed to initialize: ${err.message}`);
  }
}

export function stopDiscordAdapter(): void {
  clearAllTyping();
  setChannelsActive(false);
  if (gateway) {
    gateway.disconnect();
    gateway = null;
    console.log('[Discord] Adapter stopped');
  }
}

/**
 * Restart the Discord gateway with a fresh token from the vault.
 * Called when credential_stored fires for DISCORD_BOT_TOKEN.
 */
export async function restartDiscordGateway(): Promise<void> {
  if (!wsSend) {
    console.log('[Discord] Cannot restart — no WS send function');
    return;
  }

  console.log('[Discord] Credential updated — restarting gateway with new token...');
  stopDiscordAdapter();
  await new Promise((r) => setTimeout(r, 2000));
  await initDiscordAdapter(wsSend);
}

export function isDiscordAdapterRunning(): boolean {
  return gateway !== null;
}

export function getGatewayStatus(): {
  running: boolean;
  connected: boolean;
  destroyed: boolean;
  sessionId: string | null;
  reconnectAttempts: number;
  botUserId: string | null;
  authorizedUserId: string | null;
  pendingResponses: number;
  hasToken: boolean;
  hasChannelConfig: boolean;
} {
  const gwStatus = gateway?.getStatus();
  return {
    running: gateway !== null,
    connected: gwStatus?.connected ?? false,
    destroyed: gwStatus?.destroyed ?? false,
    sessionId: gwStatus?.sessionId ?? null,
    reconnectAttempts: gwStatus?.reconnectAttempts ?? 0,
    botUserId: gwStatus?.botUserId ?? botUserId,
    authorizedUserId,
    pendingResponses: getPendingCount(),
    hasToken: false, // filled by caller after vault check
    hasChannelConfig: !!process.env.DISCORD_CHANNEL_CONVERSATION,
  };
}

// ============================================
// INCOMING: Discord -> DotBot
// ============================================

async function handleDiscordMessage(message: DiscordMessage): Promise<void> {
  if (message.author.bot) return;

  const conversationChannelId = process.env.DISCORD_CHANNEL_CONVERSATION;
  if (!conversationChannelId || message.channel_id !== conversationChannelId) return;

  const hasContent = !!message.content.trim();
  const hasAttachments = Array.isArray(message.attachments) && message.attachments.length > 0;
  if (!hasContent && !hasAttachments) return;

  // ── Layer 1: Authorized User ID ──
  if (!authorizedUserId) {
    authorizedUserId = message.author.id;
    process.env.DISCORD_AUTHORIZED_USER_ID = authorizedUserId;
    console.log(`[Discord] Authorized user: ${message.author.username} (${authorizedUserId})`);
    persistAuthorizedUser(authorizedUserId);
  }

  if (message.author.id !== authorizedUserId) {
    console.log(`[Discord] Ignored message from unauthorized user: ${message.author.username} (${message.author.id})`);
    return;
  }

  const promptId = `discord_${nanoid()}`;
  trackPending(promptId, message.channel_id, message.id);

  // ── Download attachments and inline text content ──
  let attachmentContext = '';
  if (hasAttachments) {
    const results = await downloadAttachments(message.attachments!);
    if (results.length > 0) {
      const parts: string[] = [];
      for (const r of results) {
        if (r.inlinedContent) {
          parts.push(`--- BEGIN ATTACHED FILE: ${r.filename} ---\n${r.inlinedContent}\n--- END ATTACHED FILE: ${r.filename} ---`);
        } else {
          parts.push(`[Attached binary file: ${r.filename} — saved to ${r.path}]`);
        }
      }
      attachmentContext = '\n\n' + parts.join('\n\n');
    }
  }

  const fullPrompt = (message.content || '').trim() + attachmentContext;

  console.log(`[Discord] \u2192 Prompt from ${message.author.username}: ${fullPrompt.substring(0, 80)}${fullPrompt.length > 80 ? '...' : ''}`);
  startTypingLoop(message.channel_id);

  if (wsSend) {
    const hints = await classifyPromptLocally(fullPrompt);
    wsSend({
      type: 'prompt',
      id: promptId,
      timestamp: Date.now(),
      payload: {
        prompt: fullPrompt,
        source: 'discord',
        sourceUserId: message.author.id,
        hints,
      },
    });
  }
}

const DISCORD_TEMP_DIR = path.join(TEMP_DIR, 'discord-attachments');
const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25 MB
const MAX_INLINE_SIZE = 100 * 1024; // 100 KB — text files under this are inlined directly

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.csv', '.xml', '.yaml', '.yml', '.toml',
  '.log', '.ini', '.cfg', '.conf', '.env', '.sh', '.bat', '.ps1',
  '.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.rs', '.java',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.html', '.css', '.scss',
  '.sql', '.graphql', '.svelte', '.vue', '.astro',
]);

interface AttachmentResult {
  filename: string;
  path: string;
  inlinedContent?: string;
}

function isTextFile(filename: string, contentType?: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (contentType && (contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('xml'))) return true;
  return false;
}

async function downloadAttachments(attachments: DiscordAttachment[]): Promise<AttachmentResult[]> {
  await fs.mkdir(DISCORD_TEMP_DIR, { recursive: true });
  const results: AttachmentResult[] = [];

  for (const att of attachments) {
    if (att.size > MAX_ATTACHMENT_SIZE) {
      console.log(`[Discord] Skipping attachment ${att.filename} — too large (${(att.size / 1024 / 1024).toFixed(1)} MB)`);
      continue;
    }
    try {
      const safeName = `${att.id}_${att.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const destPath = path.join(DISCORD_TEMP_DIR, safeName);

      const res = await fetch(att.url);
      if (!res.ok) {
        console.error(`[Discord] Failed to download ${att.filename}: HTTP ${res.status}`);
        continue;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(destPath, buffer);

      const result: AttachmentResult = { filename: att.filename, path: destPath };

      // Inline text files so conversation.json has real content
      if (isTextFile(att.filename, att.content_type) && att.size <= MAX_INLINE_SIZE) {
        try {
          result.inlinedContent = buffer.toString('utf-8');
          console.log(`[Discord] Inlined attachment: ${att.filename} (${(att.size / 1024).toFixed(1)} KB)`);
        } catch {
          console.log(`[Discord] Could not inline ${att.filename} as text, keeping as binary reference`);
        }
      } else {
        console.log(`[Discord] Downloaded attachment: ${att.filename} (${(att.size / 1024).toFixed(1)} KB) → ${destPath}`);
      }

      results.push(result);
    } catch (err: any) {
      console.error(`[Discord] Failed to download attachment ${att.filename}: ${err.message}`);
    }
  }
  return results;
}

// ============================================
// OUTGOING: DotBot -> Discord
// ============================================

/**
 * Handle a response from the DotBot server.
 * If it matches a Discord-originated prompt, send it to Discord.
 * Returns true if the message was handled (consumed), false otherwise.
 */
export async function handleDiscordResponse(message: WSMessage): Promise<boolean> {
  return routeResponse(message, gateway !== null);
}

// ============================================
// GATEWAY ERROR HANDLING
// ============================================

function handleGatewayError(error: string): void {
  const isIntentError = error.toLowerCase().includes('intent');
  if (!isIntentError) return;

  const channelId = process.env.DISCORD_CHANNEL_CONVERSATION;
  const msg = [
    '\u26a0\ufe0f **Discord Gateway: Message Content Intent is not enabled**',
    '',
    "I can't read your messages until you enable it:",
    '',
    '1. Go to https://discord.com/developers/applications',
    '2. Select your **DotBot** application',
    '3. Click **Bot** in the left sidebar',
    '4. Scroll to **Privileged Gateway Intents**',
    '5. Turn on **MESSAGE CONTENT INTENT**',
    '6. Click **Save Changes**',
    '',
    'Then restart the agent (`system.restart` or re-run `run-dev.bat`).',
  ].join('\n');

  if (channelId) {
    sendToDiscord(channelId, msg).catch(() => {});
  }

  if (wsSend) {
    wsSend({
      type: 'user_notification',
      id: `discord_intent_${Date.now()}`,
      timestamp: Date.now(),
      payload: {
        title: 'Discord: Message Content Intent Required',
        message: 'The bot connected but Discord rejected the Message Content Intent. Enable it in Developer Portal \u2192 Bot \u2192 Privileged Gateway Intents \u2192 MESSAGE CONTENT INTENT, then restart.',
        source: 'discord',
        suggestedPrompt: "The Discord Message Content Intent is not enabled and I can't fix it from the API. Can you try to enable it for me using computer mode (GUI automation)? Go to https://discord.com/developers/applications, select the DotBot app, click Bot, scroll to Privileged Gateway Intents, toggle MESSAGE CONTENT INTENT on, and click Save Changes. This is experimental so let me know if it doesn't work.",
        suggestedLabel: '\ud83d\udda5\ufe0f Try to fix with Computer Mode (experimental)',
      },
    });
  }
}

// ============================================
// PROMPT INTERACTION HANDLER
// ============================================

function registerPromptInteractionHandler(): void {
  registerInteraction('prompt', async (interaction, args) => {
    await deferInteraction(interaction);
    const promptText = args || interaction.data.custom_id;
    const promptId = `discord_btn_${nanoid()}`;

    trackPending(promptId, interaction.channel_id, interaction.message?.id || '');
    startTypingLoop(interaction.channel_id);

    if (wsSend) {
      const hints = await classifyPromptLocally(promptText);
      wsSend({
        type: 'prompt',
        id: promptId,
        timestamp: Date.now(),
        payload: {
          prompt: promptText,
          source: 'discord_button',
          sourceUserId: interaction.user.id,
          hints,
        },
      });
    }
  });
}

// ============================================
// PERSISTENCE
// ============================================

async function persistAuthorizedUser(userId: string): Promise<void> {
  try {
    const { promises: fs } = await import('fs');
    const { resolve } = await import('path');
    const envPath = resolve(process.env.USERPROFILE || process.env.HOME || '', '.bot', '.env');

    let existing = '';
    try {
      existing = await fs.readFile(envPath, 'utf-8');
    } catch {
      /* file doesn't exist */
    }

    const envMap = new Map<string, string>();
    for (const line of existing.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        envMap.set(trimmed.substring(0, eqIdx).trim(), trimmed.substring(eqIdx + 1).trim());
      }
    }

    envMap.set('DISCORD_AUTHORIZED_USER_ID', userId);

    const lines = Array.from(envMap.entries()).map(([k, v]) => `${k}=${v}`);
    await fs.writeFile(envPath, lines.join('\n') + '\n', 'utf-8');

    console.log('[Discord] Saved authorized user ID to ~/.bot/.env');
  } catch (err: any) {
    console.error(`[Discord] Failed to persist authorized user: ${err.message}`);
  }
}
