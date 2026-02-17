/**
 * Discord Gateway Event Parsers
 *
 * Pure functions that transform raw Discord gateway payloads
 * into typed objects. No side effects, easily testable.
 */

import type { DiscordMessage, DiscordInteraction } from './types.js';

export function parseMessageCreate(data: any): DiscordMessage {
  return {
    id: data.id,
    channel_id: data.channel_id,
    guild_id: data.guild_id,
    author: {
      id: data.author.id,
      username: data.author.username,
      bot: data.author.bot || false,
    },
    content: data.content,
    timestamp: data.timestamp,
    attachments: Array.isArray(data.attachments) && data.attachments.length > 0
      ? data.attachments.map((a: any) => ({
          id: a.id,
          filename: a.filename,
          url: a.url,
          size: a.size,
          content_type: a.content_type,
        }))
      : undefined,
  };
}

export function parseInteractionCreate(data: any): DiscordInteraction | null {
  if (data.type !== 3) return null; // Only MESSAGE_COMPONENT (buttons, selects)
  const user = data.member?.user || data.user;
  return {
    id: data.id,
    token: data.token,
    type: data.type,
    channel_id: data.channel_id,
    guild_id: data.guild_id,
    message: data.message,
    data: {
      custom_id: data.data?.custom_id,
      component_type: data.data?.component_type,
    },
    user: {
      id: user?.id || 'unknown',
      username: user?.username || 'unknown',
    },
  };
}
