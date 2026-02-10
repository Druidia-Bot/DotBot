/**
 * Task Monitor
 * 
 * Per-task timers that track execution duration and notify the user
 * when tasks take longer than expected. Replaces the pulse-clock concept.
 * 
 * Flow:
 * 1. Runner creates a task → startTaskTimer(taskId, estimateMs, notify)
 * 2. Timer fires after estimate → if still active, notify user + extend
 * 3. Keeps extending (50% of original each time) up to MAX_EXTENSIONS
 * 4. Runner completes/fails task → clearTaskTimer(taskId)
 */

import { createComponentLogger } from "../logging.js";
import type { TaskProgressUpdate } from "../types/agent.js";

const log = createComponentLogger("task-monitor");

// ============================================
// CONFIG
// ============================================

/** Max times we extend the timer before declaring timeout */
const MAX_EXTENSIONS = 5;

/** Time estimates by request classification (ms) */
const ESTIMATE_BY_CLASSIFICATION: Record<string, number> = {
  INFO_REQUEST: 15_000,
  ACTION: 30_000,
  COMPOUND: 60_000,
  CONTINUATION: 30_000,
  CONVERSATIONAL: 10_000,
  MEMORY_UPDATE: 10_000,
};

const DEFAULT_ESTIMATE_MS = 30_000;

// ============================================
// STATE
// ============================================

interface MonitoredTask {
  taskId: string;
  estimateMs: number;
  startedAt: number;
  timer: NodeJS.Timeout;
  extensions: number;
  notify: (update: TaskProgressUpdate) => void;
}

const tasks = new Map<string, MonitoredTask>();

// ============================================
// PUBLIC API
// ============================================

/**
 * Get a time estimate (ms) for a request classification.
 */
export function getTimeEstimate(classification: string): number {
  return ESTIMATE_BY_CLASSIFICATION[classification] || DEFAULT_ESTIMATE_MS;
}

/**
 * Start monitoring a task. When the timer fires and the task is still
 * active, notify the user and extend the timer.
 */
export function startTaskTimer(
  taskId: string,
  estimateMs: number,
  notify: (update: TaskProgressUpdate) => void
): void {
  // Clear any existing timer for this task
  clearTaskTimer(taskId);

  const task: MonitoredTask = {
    taskId,
    estimateMs,
    startedAt: Date.now(),
    timer: setTimeout(() => onTimerFire(taskId), estimateMs),
    extensions: 0,
    notify,
  };

  tasks.set(taskId, task);
  log.debug("Task timer started", { taskId, estimateMs });
}

/**
 * Clear a task's timer (call on complete or fail).
 */
export function clearTaskTimer(taskId: string): void {
  const task = tasks.get(taskId);
  if (task) {
    clearTimeout(task.timer);
    tasks.delete(taskId);
    log.debug("Task timer cleared", { taskId, elapsed: Date.now() - task.startedAt });
  }
}

/**
 * How many tasks are currently being monitored.
 */
export function getActiveTaskCount(): number {
  return tasks.size;
}

// ============================================
// TIMER LOGIC
// ============================================

function onTimerFire(taskId: string): void {
  const task = tasks.get(taskId);
  if (!task) return;

  task.extensions++;
  const elapsedSec = Math.round((Date.now() - task.startedAt) / 1000);
  const estimateSec = Math.round(task.estimateMs / 1000);

  if (task.extensions > MAX_EXTENSIONS) {
    // Too many extensions — likely stuck
    log.warn("Task exceeded max extensions", { taskId, elapsedSec, extensions: task.extensions });

    task.notify({
      taskId,
      status: "timeout",
      message: `Task has been running for ${elapsedSec}s (estimated ${estimateSec}s). It may be stuck.`,
    });

    tasks.delete(taskId);
    return;
  }

  // Notify user that task is taking longer than expected
  log.info("Task overdue — extending timer", { taskId, elapsedSec, extension: task.extensions });

  task.notify({
    taskId,
    status: "running",
    message: `Still working... (${elapsedSec}s elapsed, estimated ${estimateSec}s)`,
  });

  // Extend by 50% of original estimate each time
  const extensionMs = Math.round(task.estimateMs * 0.5);
  task.timer = setTimeout(() => onTimerFire(taskId), extensionMs);
}
