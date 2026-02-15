/**
 * Recurring Tasks — Service (Lifecycle Orchestrator)
 *
 * Thin orchestrator that wires together schema, CRUD, timer, and execution.
 * Owns the start/stop lifecycle and event emission.
 */

import { createComponentLogger } from "#logging.js";
import type {
  RecurringTask,
  CreateRecurringTaskParams,
  RecurringEvent,
  RecurringEventCallback,
  RecurringSchedulerConfig,
  TaskSchedule,
} from "../recurring-types.js";
import { DEFAULT_RECURRING_CONFIG } from "../recurring-types.js";
import { ensureRecurringSchema } from "./schema.js";
import {
  insertRecurringTask,
  getRecurringTask,
  listRecurringTasks,
  cancelRecurringTaskInDb,
  pauseRecurringTaskInDb,
  resumeRecurringTaskInDb,
  getOfflineResults,
  getUpcomingRecurringTasks,
  pruneOldCancelledTasks,
} from "./crud.js";
import { setTimerRunning, setPollCallback, scheduleNextPoll } from "./timer.js";
import { pollDueTasks, drainActiveExecutions, executeRecurringTaskNow } from "./execution.js";
import { calculateNextRun } from "./schedule-calc.js";

const log = createComponentLogger("recurring-scheduler");

// ============================================
// STATE
// ============================================

let config: RecurringSchedulerConfig = { ...DEFAULT_RECURRING_CONFIG };
let running = false;
const eventListeners: RecurringEventCallback[] = [];

/** Callback to execute a recurring task prompt */
let executeCallback: ((task: RecurringTask) => Promise<string>) | null = null;

// ============================================
// INITIALIZATION
// ============================================

/**
 * Start the recurring scheduler.
 */
export function startRecurringScheduler(
  overrides?: Partial<RecurringSchedulerConfig>
): void {
  if (running) {
    log.warn("Recurring scheduler already running");
    return;
  }

  config = { ...DEFAULT_RECURRING_CONFIG, ...overrides };
  running = true;

  ensureRecurringSchema();
  setTimerRunning(true);
  setPollCallback(() => pollDueTasks(config, executeCallback, emitEvent));

  log.info("Recurring scheduler started", {
    maxConcurrent: config.maxConcurrent,
  });

  // Run an immediate poll, then arm the timer wheel
  pollDueTasks(config, executeCallback, emitEvent).then(() => scheduleNextPoll());
}

/**
 * Stop the recurring scheduler gracefully.
 */
export async function stopRecurringScheduler(): Promise<void> {
  if (!running) return;

  running = false;
  setTimerRunning(false);

  const remaining = await drainActiveExecutions(30_000);
  log.info("Recurring scheduler stopped", { activeExecutions: remaining });
}

/**
 * Set the callback used to execute recurring task prompts.
 */
export function setRecurringExecuteCallback(
  callback: (task: RecurringTask) => Promise<string>
): void {
  executeCallback = callback;
}

/**
 * Register a listener for recurring scheduler events.
 */
export function onRecurringEvent(callback: RecurringEventCallback): void {
  eventListeners.push(callback);
}

// ============================================
// PUBLIC TASK API (delegates to CRUD + events)
// ============================================

/**
 * Create a new recurring task.
 */
export function createRecurringTask(
  params: CreateRecurringTaskParams
): RecurringTask {
  const task = insertRecurringTask(params, config.defaultMaxFailures);

  emitEvent({
    type: "recurring_created",
    taskId: task.id,
    userId: task.userId,
    taskName: task.name,
    timestamp: new Date(),
    details: {
      scheduleType: task.scheduleType,
      nextRunAt: task.nextRunAt.toISOString(),
    },
  });

  // Re-arm timer — this new task might be sooner than the current timer
  scheduleNextPoll();

  return task;
}

/**
 * Cancel a recurring task.
 */
export function cancelRecurringTask(
  taskId: string,
  userId: string
): boolean {
  const cancelled = cancelRecurringTaskInDb(taskId, userId);
  if (cancelled) {
    const task = getRecurringTask(taskId);
    if (task) {
      emitEvent({
        type: "recurring_cancelled",
        taskId,
        userId: task.userId,
        taskName: task.name,
        timestamp: new Date(),
      });
    }
    // Re-arm timer — cancelled task may have been the next due
    scheduleNextPoll();
  }
  return cancelled;
}

/**
 * Pause a recurring task.
 */
export function pauseRecurringTask(
  taskId: string,
  userId: string
): boolean {
  const paused = pauseRecurringTaskInDb(taskId, userId);
  if (paused) {
    const task = getRecurringTask(taskId);
    if (task) {
      emitEvent({
        type: "recurring_paused",
        taskId,
        userId: task.userId,
        taskName: task.name,
        timestamp: new Date(),
      });
    }
    // Re-arm timer — paused task removed from active pool
    scheduleNextPoll();
  }
  return paused;
}

/**
 * Resume a paused recurring task. Resets failures and recalculates next run.
 */
export function resumeRecurringTask(
  taskId: string,
  userId: string
): boolean {
  const nextRun = resumeRecurringTaskInDb(taskId, userId);
  if (nextRun) {
    const task = getRecurringTask(taskId);
    if (task) {
      emitEvent({
        type: "recurring_resumed",
        taskId,
        userId: task.userId,
        taskName: task.name,
        timestamp: new Date(),
        details: { nextRunAt: nextRun.toISOString() },
      });
    }
    // Re-arm timer — resumed task has a new next_run_at
    scheduleNextPoll();
    return true;
  }
  return false;
}

/**
 * Manually execute a missed task (user confirmed they want to run it).
 */
export async function executeTaskNow(
  taskId: string,
  userId: string
): Promise<boolean> {
  return executeRecurringTaskNow(taskId, userId, executeCallback, emitEvent);
}

// ============================================
// RE-EXPORTS (public read-only API)
// ============================================

export {
  getRecurringTask,
  listRecurringTasks,
  getOfflineResults,
  getUpcomingRecurringTasks,
  pruneOldCancelledTasks,
  calculateNextRun,
};

// ============================================
// EVENT EMISSION
// ============================================

function emitEvent(event: RecurringEvent): void {
  for (const listener of eventListeners) {
    try {
      listener(event);
    } catch (error) {
      log.error("Recurring event listener error", { error });
    }
  }
}
