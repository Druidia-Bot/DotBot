/**
 * Bridge Notifications — Fire-and-Forget Senders
 *
 * One-way messages sent to the local agent or broadcast to user devices.
 * No response expected — these are best-effort notifications for
 * thread persistence, run logging, agent lifecycle, and task progress.
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "#logging.js";
import { devices, sendMessage, broadcastToUser } from "../devices.js";

const log = createComponentLogger("ws.bridge");

// ============================================
// THREAD PERSISTENCE
// ============================================

/**
 * Save an entry to a thread on the local agent's disk.
 * Creates the thread if it doesn't exist.
 * Fire-and-forget — no response expected.
 */
export function sendSaveToThread(
  userId: string,
  threadId: string,
  entry: { role: string; content: string; [key: string]: unknown },
  topic?: string,
): void {
  for (const device of devices.values()) {
    if (device.session.userId === userId && device.session.capabilities?.includes("memory")) {
      sendMessage(device.ws, {
        type: "save_to_thread",
        id: nanoid(),
        timestamp: Date.now(),
        payload: {
          threadId,
          createIfMissing: true,
          newThreadTopic: topic,
          entry,
        },
      });
      return;
    }
  }
  log.warn("No local agent for save_to_thread", { userId, threadId });
}

// ============================================
// RUN LOG
// ============================================

/**
 * Send a pipeline execution log to the local agent for persistence.
 * The local agent writes these to ~/.bot/run-logs/ as JSON files.
 * Fire-and-forget — no response expected.
 */
export function sendRunLog(userId: string, payload: Record<string, unknown>): void {
  for (const device of devices.values()) {
    if (device.session.userId === userId && device.session.capabilities?.includes("memory")) {
      sendMessage(device.ws, {
        type: "run_log",
        id: nanoid(),
        timestamp: Date.now(),
        payload,
      });
      return;
    }
  }
  log.warn("No local agent for run_log", { userId });
}

// ============================================
// AGENT LIFECYCLE
// ============================================

/**
 * Send an agent lifecycle notification to the user.
 * The local agent routes source="agent_lifecycle" to Discord #updates + #logs
 * (not #conversation — lifecycle events are status updates, not chat).
 *
 * Fire-and-forget — no response expected.
 */
export function sendAgentLifecycle(deviceId: string, notification: {
  event: string;
  agentId?: string;
  message: string;
  detail?: string;
}): void {
  const device = devices.get(deviceId);
  if (!device) return;

  const userId = device.session.userId;
  broadcastToUser(userId, {
    type: "user_notification",
    id: nanoid(),
    timestamp: Date.now(),
    payload: {
      source: "agent_lifecycle",
      ...notification,
    },
  });
}

// ============================================
// TASK PROGRESS
// ============================================

/**
 * Send a task_progress notification to the local agent.
 * Messages with eventType are forwarded to Discord #logs by the message-router.
 * Fire-and-forget — no response expected.
 */
export function sendTaskProgress(deviceId: string, progress: {
  eventType: string;
  status: string;
  message: string;
  success?: boolean;
  persona?: string;
}): void {
  const device = devices.get(deviceId);
  if (!device) return;

  sendMessage(device.ws, {
    type: "task_progress",
    id: nanoid(),
    timestamp: Date.now(),
    payload: progress,
  });
}
