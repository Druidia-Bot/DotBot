/**
 * Discord Channel Routing
 *
 * Routes outgoing messages to the correct Discord channel
 * (#conversation, #updates, #logs) based on env configuration.
 * Silently no-ops when the adapter is inactive or channels aren't configured.
 */

import { sendToDiscord } from './rest.js';
import type { DiscordLogVerbosity } from './types.js';

let active = false;

/** Called by the adapter on init/stop to gate channel sends. */
export function setChannelsActive(isActive: boolean): void {
  active = isActive;
}

export async function sendToConversationChannel(content: string): Promise<void> {
  if (!active) return;
  const channelId = process.env.DISCORD_CHANNEL_CONVERSATION;
  if (!channelId) return;
  await sendToDiscord(channelId, content);
}

export async function sendToUpdatesChannel(content: string): Promise<void> {
  if (!active) return;
  const channelId = process.env.DISCORD_CHANNEL_UPDATES;
  if (!channelId) return;
  await sendToDiscord(channelId, content);
}

function getLogVerbosity(): DiscordLogVerbosity {
  const v = (process.env.DISCORD_LOG_VERBOSITY || 'summary').toLowerCase();
  if (v === 'full' || v === 'summary' || v === 'off') return v;
  return 'summary';
}

/**
 * Send a log entry to the #logs channel.
 * Respects DISCORD_LOG_VERBOSITY:
 *   - level "detail" (tool calls, stream chunks) requires verbosity "full"
 *   - level "summary" (lifecycle events) requires verbosity "summary" or "full"
 */
export async function sendToLogsChannel(content: string, level: 'detail' | 'summary' = 'summary'): Promise<void> {
  if (!active) return;
  const channelId = process.env.DISCORD_CHANNEL_LOGS;
  if (!channelId) return;

  const verbosity = getLogVerbosity();
  if (verbosity === 'off') return;
  if (verbosity === 'summary' && level === 'detail') return;

  await sendToDiscord(channelId, content);
}
