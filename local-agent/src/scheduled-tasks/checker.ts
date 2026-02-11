/**
 * Scheduled Task Checker — Periodic Task
 * 
 * Checks ~/.bot/scheduled-tasks.json every 60 seconds for due tasks.
 * 
 * When a task is due (within 2-hour grace period):
 *   1. Submits its prompt to the server pipeline via WebSocket
 *   2. Waits for the response (matched by message ID or server task ID)
 *   3. Delivers the result to #conversation + #updates
 *   4. Advances nextRunAt to the next occurrence
 * 
 * When a task is missed (beyond 2-hour grace period):
 *   1. Sends a message to #conversation asking the user if they want to run it
 *   2. Advances nextRunAt regardless (don't pile up missed runs)
 * 
 * Response matching uses two-phase tracking:
 *   Phase 1: promptId → meta  (set when prompt is sent)
 *   Phase 2: serverTaskId → meta  (set when routing ack arrives with agentTaskId)
 *   Inline responses match by promptId; background tasks match by serverTaskId.
 * 
 * Registered with the periodic manager alongside heartbeat and reminders.
 */

import { nanoid } from "nanoid";
import {
  getDueAndMissedTasks,
  getScheduledTask,
  markTaskRun,
  markTaskFailed,
  advanceMissedTask,
} from "./store.js";
import type { ScheduledTask } from "./store.js";
import type { WSMessage } from "../types.js";

// ============================================
// CONSTANTS
// ============================================

const MAX_CONCURRENT = 2;
const TASK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per task

// ============================================
// TYPES
// ============================================

interface PendingMeta {
  taskId: string;       // Our scheduled task ID (sched_xxx)
  taskName: string;
  startedAt: number;
}

// ============================================
// STATE
// ============================================

let wsSend: ((message: WSMessage) => void) | null = null;

/**
 * Phase 1: promptId → meta. Set when we send the prompt.
 * Matched by inline `response` messages (fast path).
 * Consumed by routing ack to transition to Phase 2.
 */
const pendingByPromptId = new Map<string, PendingMeta>();

/**
 * Phase 2: serverTaskId → meta. Set when routing ack arrives with `agentTaskId`.
 * Matched by `agent_complete` messages (background task path).
 */
const pendingByServerTaskId = new Map<string, PendingMeta>();

/**
 * Set of scheduled task IDs currently in-flight (prevent duplicate submissions).
 */
const inFlightTaskIds = new Set<string>();

/** Callbacks wired from index.ts */
let onTaskResult: ((task: ScheduledTask, result: string) => void) | null = null;
let onTaskError: ((task: ScheduledTask, error: string, paused: boolean) => void) | null = null;
let onMissedTask: ((task: ScheduledTask) => void) | null = null;

// ============================================
// INITIALIZATION
// ============================================

/**
 * Wire up the WS send function. Called from index.ts on each connect/reconnect.
 * Clears stale pending state from previous connections.
 */
export function initScheduledTaskChecker(send: (message: WSMessage) => void): void {
  wsSend = send;
  // Clear stale state — old prompt IDs are meaningless on a new WS session
  pendingByPromptId.clear();
  pendingByServerTaskId.clear();
  inFlightTaskIds.clear();
}

/**
 * Set callback for successful task results → #conversation + #updates.
 */
export function setScheduledTaskResultCallback(cb: (task: ScheduledTask, result: string) => void): void {
  onTaskResult = cb;
}

/**
 * Set callback for task errors → #updates.
 */
export function setScheduledTaskErrorCallback(cb: (task: ScheduledTask, error: string, paused: boolean) => void): void {
  onTaskError = cb;
}

/**
 * Set callback for missed tasks → #conversation (ask user).
 */
export function setScheduledTaskMissedCallback(cb: (task: ScheduledTask) => void): void {
  onMissedTask = cb;
}

// ============================================
// CHECK (called by periodic manager)
// ============================================

/**
 * Gate function: allow checks only when WS is connected.
 * Pure predicate — no side effects.
 */
export function canCheckScheduledTasks(): boolean {
  return wsSend !== null;
}

/**
 * Main check: find due/missed tasks and handle them.
 */
export async function checkScheduledTasks(): Promise<void> {
  if (!wsSend) return;

  // Clean up timed-out executions before checking for new ones
  await cleanupTimedOut();

  let dueTasks;
  try {
    dueTasks = await getDueAndMissedTasks();
  } catch (err) {
    console.error("[Scheduled] Error reading tasks:", err);
    return;
  }

  if (dueTasks.length === 0) return;

  for (const { task, type } of dueTasks) {
    if (type === "missed") {
      // Beyond grace period — ask user, advance to next run
      console.log(`[Scheduled] Missed task "${task.name}" (was due ${task.nextRunAt})`);
      if (onMissedTask) {
        onMissedTask(task);
      }
      await advanceMissedTask(task.id);
      continue;
    }

    // type === "due" — execute if under concurrency limit (recheck each iteration)
    const totalPending = pendingByPromptId.size + pendingByServerTaskId.size;
    if (totalPending >= MAX_CONCURRENT) {
      console.log(`[Scheduled] Skipping "${task.name}" — ${MAX_CONCURRENT} tasks already running`);
      continue;
    }

    // Guard: don't re-submit a task that's already in-flight
    if (inFlightTaskIds.has(task.id)) {
      continue;
    }

    // Submit prompt to server pipeline
    const promptId = `sched_${nanoid(8)}`;
    console.log(`[Scheduled] Running "${task.name}" (${promptId})`);

    const meta: PendingMeta = {
      taskId: task.id,
      taskName: task.name,
      startedAt: Date.now(),
    };

    pendingByPromptId.set(promptId, meta);
    inFlightTaskIds.add(task.id);

    wsSend({
      type: "prompt",
      id: promptId,
      timestamp: Date.now(),
      payload: {
        prompt: task.prompt,
        source: "scheduled_task",
        scheduledTaskId: task.id,
        scheduledTaskName: task.name,
        hints: {
          personaHint: task.personaHint,
        },
      },
    });
  }
}

// ============================================
// RESPONSE HANDLING (called from index.ts)
// ============================================

/**
 * Check if an incoming WS message is a response to a scheduled task prompt.
 * Returns true if handled (caller should skip normal routing).
 *
 * Two-phase matching:
 *   1. `response` with isRoutingAck + agentTaskId → transition to Phase 2
 *   2. `response` without isRoutingAck → inline result (fast path)
 *   3. `agent_complete` → match by server taskId (Phase 2)
 */
export function handleScheduledTaskResponse(message: WSMessage): boolean {
  if (message.type === "response") {
    const pending = pendingByPromptId.get(message.id);
    if (!pending) return false;

    const payload = message.payload || {};

    // Phase transition: routing ack with server task ID → move to Phase 2
    if (payload.isRoutingAck && payload.agentTaskId) {
      pendingByPromptId.delete(message.id);
      pendingByServerTaskId.set(payload.agentTaskId, {
        ...pending,
        startedAt: Date.now(), // reset timer — the real work starts now
      });
      // Don't return true — let the ack pass through to normal routing
      // (Discord adapter suppresses it, console prints it)
      return false;
    }

    // Routing ack without agentTaskId — don't treat as inline result.
    // The ack text ("On it — I've assigned...") is NOT the task result.
    if (payload.isRoutingAck) {
      return false;
    }

    // Inline result (fast path — no background task spawned)
    pendingByPromptId.delete(message.id);
    inFlightTaskIds.delete(pending.taskId);
    completeTask(pending.taskId, pending.taskName, payload.response || "");
    return true;
  }

  // Server error for our prompt — fail immediately instead of waiting for timeout
  if (message.type === "error") {
    const pending = pendingByPromptId.get(message.id);
    if (!pending) return false;

    pendingByPromptId.delete(message.id);
    inFlightTaskIds.delete(pending.taskId);
    failTask(pending.taskId, pending.taskName, message.payload?.error || "Server error");
    return true;
  }

  if (message.type === "agent_complete") {
    const serverTaskId = message.payload?.taskId;
    if (!serverTaskId) return false;

    const pending = pendingByServerTaskId.get(serverTaskId);
    if (!pending) return false;

    pendingByServerTaskId.delete(serverTaskId);
    inFlightTaskIds.delete(pending.taskId);

    const result = message.payload?.response || "";
    const success = message.payload?.success !== false;

    if (success) {
      completeTask(pending.taskId, pending.taskName, result);
    } else {
      failTask(pending.taskId, pending.taskName, result || "Task failed");
    }
    return true;
  }

  return false;
}

// ============================================
// INTERNAL
// ============================================

async function cleanupTimedOut(): Promise<void> {
  const now = Date.now();
  const timedOut: { key: string; meta: PendingMeta; phase: string; map: Map<string, PendingMeta> }[] = [];

  for (const [key, meta] of pendingByPromptId) {
    if (now - meta.startedAt > TASK_TIMEOUT_MS) {
      timedOut.push({ key, meta, phase: "prompt", map: pendingByPromptId });
    }
  }
  for (const [key, meta] of pendingByServerTaskId) {
    if (now - meta.startedAt > TASK_TIMEOUT_MS) {
      timedOut.push({ key, meta, phase: "execution", map: pendingByServerTaskId });
    }
  }

  for (const { key, meta, phase, map } of timedOut) {
    console.log(`[Scheduled] Task "${meta.taskName}" timed out (${phase} phase)`);
    map.delete(key);
    inFlightTaskIds.delete(meta.taskId);
    await failTask(meta.taskId, meta.taskName, "Execution timed out");
  }
}

async function completeTask(taskId: string, taskName: string, result: string): Promise<void> {
  console.log(`[Scheduled] Task "${taskName}" completed (${result.length} chars)`);

  try {
    await markTaskRun(taskId, result);
  } catch (err) {
    console.error(`[Scheduled] Failed to update task "${taskName}":`, err);
  }

  try {
    const task = await getScheduledTask(taskId);
    if (task && onTaskResult) {
      onTaskResult(task, result);
    }
  } catch {
    // Best effort — the result was already saved
  }
}

async function failTask(taskId: string, taskName: string, error: string): Promise<void> {
  console.log(`[Scheduled] Task "${taskName}" failed: ${error}`);

  let paused = false;
  try {
    paused = await markTaskFailed(taskId, error);
    if (paused) {
      console.log(`[Scheduled] Task "${taskName}" paused after repeated failures`);
    }
  } catch (err) {
    console.error(`[Scheduled] Failed to record failure for "${taskName}":`, err);
  }

  try {
    const task = await getScheduledTask(taskId);
    if (task && onTaskError) {
      onTaskError(task, error, paused);
    }
  } catch {
    // Best effort — the failure was already recorded
  }
}
