/**
 * Discord REST API Layer
 *
 * All HTTP communication with Discord's REST API goes through here,
 * routed via the credential proxy so the bot token never leaks.
 *
 * Covers: sending messages, embeds, typing indicators, interaction responses.
 */

import { credentialProxyFetch } from "../credential-proxy.js";
import type { DiscordInteraction } from "./types.js";

export const DISCORD_API = "https://discord.com/api/v10";
export const DISCORD_CREDENTIAL_NAME = "DISCORD_BOT_TOKEN";

const DISCORD_MAX_LENGTH = 2000;
const USER_AGENT = "DotBot (https://getmy.bot, 1.0)";

// ── Typing Indicator ──

const typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

async function triggerTyping(channelId: string): Promise<void> {
  try {
    await credentialProxyFetch(`/channels/${channelId}/typing`, DISCORD_CREDENTIAL_NAME, {
      baseUrl: DISCORD_API,
      method: "POST",
      headers: { "User-Agent": USER_AGENT },
      placement: { header: "Authorization", prefix: "Bot " },
    });
  } catch {
    // Non-fatal — typing indicator is cosmetic
  }
}

export function startTypingLoop(channelId: string): void {
  stopTyping(channelId);
  triggerTyping(channelId);
  // Discord typing indicator lasts ~10s, re-trigger every 8s
  const interval = setInterval(() => triggerTyping(channelId), 8_000);
  typingIntervals.set(channelId, interval);
}

export function stopTyping(channelId: string): void {
  const interval = typingIntervals.get(channelId);
  if (interval) {
    clearInterval(interval);
    typingIntervals.delete(channelId);
  }
}

export function clearAllTyping(): void {
  for (const [channelId] of typingIntervals) {
    stopTyping(channelId);
  }
}

// ── Send Messages ──

export async function sendToDiscord(channelId: string, content: string): Promise<void> {
  try {
    // Sanitize: prevent @everyone/@here pings from LLM output
    const sanitized = content.replace(/@(everyone|here)/g, "@\u200b$1");

    // Detect base64 image markdown: ![alt](data:image/...;base64,...)
    const base64ImageRegex = /!\[([^\]]*)\]\(data:(image\/[a-zA-Z+]+);base64,([A-Za-z0-9+/=\s]+)\)/g;
    const images: { alt: string; mimeType: string; data: string }[] = [];
    let textOnly = sanitized;
    let match: RegExpExecArray | null;

    while ((match = base64ImageRegex.exec(sanitized)) !== null) {
      images.push({ alt: match[1] || "image", mimeType: match[2], data: match[3].replace(/\s/g, "") });
    }

    if (images.length > 0) {
      // Strip base64 markdown from text, send images as attachments
      textOnly = sanitized.replace(base64ImageRegex, "").trim();
      await sendWithAttachments(channelId, textOnly, images);
      return;
    }

    const chunks = splitMessage(sanitized);
    for (const chunk of chunks) {
      const result = await credentialProxyFetch(`/channels/${channelId}/messages`, DISCORD_CREDENTIAL_NAME, {
        baseUrl: DISCORD_API,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({ content: chunk }),
        placement: { header: "Authorization", prefix: "Bot " },
      });
      if (result && !result.ok) {
        console.error(`[Discord] POST failed: status=${result.status} body=${result.body?.slice(0, 200)}`);
      }
    }
  } catch (err: any) {
    console.error(`[Discord] Failed to send message: ${err.message}`);
  }
}

/**
 * Send a message with file attachments to Discord.
 * Uses multipart/form-data via the credential proxy.
 */
async function sendWithAttachments(
  channelId: string,
  text: string,
  images: { alt: string; mimeType: string; data: string }[],
): Promise<void> {
  const ext = (mime: string) => {
    if (mime.includes("png")) return "png";
    if (mime.includes("gif")) return "gif";
    if (mime.includes("webp")) return "webp";
    return "jpg";
  };

  const attachments = images.map((img, i) => ({
    id: i,
    filename: `${img.alt.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "image"}.${ext(img.mimeType)}`,
    description: img.alt,
  }));

  const files = images.map((img, i) => ({
    fieldName: `files[${i}]`,
    filename: attachments[i].filename,
    contentType: img.mimeType,
    data: img.data,
  }));

  const payload: any = { attachments };
  if (text) payload.content = text.slice(0, DISCORD_MAX_LENGTH);

  const result = await credentialProxyFetch(`/channels/${channelId}/messages`, DISCORD_CREDENTIAL_NAME, {
    baseUrl: DISCORD_API,
    method: "POST",
    headers: { "User-Agent": USER_AGENT },
    body: JSON.stringify(payload),
    files,
    placement: { header: "Authorization", prefix: "Bot " },
  });

  if (result && !result.ok) {
    console.error(`[Discord] Attachment POST failed: status=${result.status} body=${result.body?.slice(0, 300)}`);
    // Fallback: send text only if attachment upload failed
    if (text) {
      await sendToDiscord(channelId, text + "\n\n*(Image attachment failed to upload)*");
    }
  }
}

export async function sendEmbedsToDiscord(
  channelId: string,
  agents: Array<{ topic: string; response: string }>,
): Promise<void> {
  try {
    const colors = [
      0x5865F2, // Blurple
      0x57F287, // Green
      0xFEE75C, // Yellow
      0xEB459E, // Fuchsia
      0xED4245, // Red
    ];

    const embeds = agents.map((agent, idx) => {
      const sanitized = agent.response.replace(/@(everyone|here)/g, "@\u200b$1");
      const description = sanitized.length > 4096
        ? sanitized.substring(0, 4093) + "..."
        : sanitized;

      return {
        title: agent.topic,
        description,
        color: colors[idx % colors.length],
        footer: { text: `Agent ${idx + 1} of ${agents.length}` },
      };
    });

    // Send embeds in batches of 10 (Discord limit)
    for (let i = 0; i < embeds.length; i += 10) {
      const batch = embeds.slice(i, i + 10);
      await credentialProxyFetch(`/channels/${channelId}/messages`, DISCORD_CREDENTIAL_NAME, {
        baseUrl: DISCORD_API,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({ embeds: batch }),
        placement: { header: "Authorization", prefix: "Bot " },
      });
    }
  } catch (err: any) {
    console.error(`[Discord] Failed to send embeds: ${err.message}`);
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

    let splitIdx = remaining.lastIndexOf("\n", DISCORD_MAX_LENGTH);
    if (splitIdx < DISCORD_MAX_LENGTH * 0.5) {
      splitIdx = remaining.lastIndexOf(" ", DISCORD_MAX_LENGTH);
    }
    if (splitIdx <= 0) {
      splitIdx = DISCORD_MAX_LENGTH;
    }

    chunks.push(remaining.substring(0, splitIdx));
    remaining = remaining.substring(splitIdx).trimStart();
  }

  return chunks;
}

// ── Interaction Responses ──

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
          "User-Agent": USER_AGENT,
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
          "User-Agent": USER_AGENT,
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

export async function followUpInteraction(
  interaction: DiscordInteraction,
  content: string,
  botUserId: string | null,
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
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({ content }),
        placement: { header: "Authorization", prefix: "Bot " },
      },
    );
  } catch (err: any) {
    console.error(`[Discord] Failed to follow up interaction: ${err.message}`);
  }
}
