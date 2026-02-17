/**
 * Discord Response Tracker
 *
 * Tracks pending Discord-originated prompts and routes DotBot server
 * responses back to the correct Discord channel. Owns the pending
 * response state (Maps) and cleanup timers.
 */

import { sendToDiscord, sendEmbedsToDiscord, stopTyping } from './rest.js';
import type { WSMessage } from '../types.js';

interface PendingResponse {
  channelId: string;
  discordMessageId: string;
  taskId?: string;
}

// Pending response timeout — must exceed watchdog KILL_TOTAL_MS (10min) + LLM processing time.
// 2 hours covers long-running research/compound tasks that chain multiple personas.
const PENDING_TTL_MS = 2 * 60 * 60 * 1000;

const pendingResponses = new Map<string, PendingResponse>();

// Durable fallback: track Discord-originated task IDs + channel so we can
// still deliver agent_complete even if the pending entry expired.
const taskChannels = new Map<string, string>();

// ── State API (used by adapter) ──

export function trackPending(promptId: string, channelId: string, discordMessageId: string): void {
  pendingResponses.set(promptId, { channelId, discordMessageId });

  // Auto-cleanup stale entries to prevent memory leaks
  setTimeout(() => {
    if (pendingResponses.has(promptId)) {
      pendingResponses.delete(promptId);
      stopTyping(channelId);
    }
  }, PENDING_TTL_MS);
}

export function clearAllPending(): number {
  const staleCount = pendingResponses.size;
  for (const [, entry] of pendingResponses) {
    stopTyping(entry.channelId);
  }
  pendingResponses.clear();
  taskChannels.clear();
  return staleCount;
}

export function getPendingCount(): number {
  return pendingResponses.size;
}

// ── Response Router ──

/**
 * Route a DotBot server message to Discord if it matches a pending prompt.
 * Returns true if the message was consumed, false if unrelated to Discord.
 */
export async function routeResponse(message: WSMessage, isActive: boolean): Promise<boolean> {
  if (!isActive) return false;

  switch (message.type) {
    case 'response': {
      const pending = pendingResponses.get(message.id);
      if (!pending) return false;

      const payload = message.payload;

      // Background task ack (has agentTaskId)
      if (payload.agentTaskId) {
        pending.taskId = payload.agentTaskId;
        pendingResponses.set(message.id, pending);

        pendingResponses.set(`task_${payload.agentTaskId}`, {
          channelId: pending.channelId,
          discordMessageId: pending.discordMessageId,
          taskId: payload.agentTaskId,
        });

        taskChannels.set(payload.agentTaskId, pending.channelId);

        if (payload.response) {
          sendToDiscord(pending.channelId, payload.response);
        }
        return true;
      }

      // Routing acks (injection, status query, resume) — suppress on Discord
      if (payload.isRoutingAck) {
        pendingResponses.delete(message.id);
        return true;
      }

      // Inline response — send to Discord and clean up
      pendingResponses.delete(message.id);
      stopTyping(pending.channelId);

      if (payload.multiAgent && payload.agents && payload.agents.length > 0) {
        await sendEmbedsToDiscord(pending.channelId, payload.agents);
      } else if (payload.response) {
        await sendToDiscord(pending.channelId, payload.response);
      }
      return true;
    }

    case 'agent_complete': {
      const taskId = message.payload?.taskId;
      if (!taskId) return false;

      const pending = pendingResponses.get(`task_${taskId}`);
      const channelId = pending?.channelId || taskChannels.get(taskId) || null;

      taskChannels.delete(taskId);
      if (!channelId) return false;

      stopTyping(channelId);

      // Clean up both pending entries
      pendingResponses.delete(`task_${taskId}`);
      for (const [key, val] of pendingResponses) {
        if (val.taskId === taskId && key !== `task_${taskId}`) {
          pendingResponses.delete(key);
          break;
        }
      }

      if (message.payload.multiAgent && message.payload.agents && message.payload.agents.length > 0) {
        await sendEmbedsToDiscord(channelId, message.payload.agents);
      } else if (message.payload.response) {
        await sendToDiscord(channelId, message.payload.response);
      }
      return true;
    }

    case 'task_progress': {
      // Typing indicator is sufficient — don't forward tool progress to Discord
      const taskId = message.payload?.taskId;
      if (!taskId) return false;
      return pendingResponses.has(`task_${taskId}`);
    }

    default:
      return false;
  }
}
