/**
 * Recurring Tasks — Polling & Execution
 *
 * Polls for due recurring tasks, checks client connectivity,
 * handles missed tasks (2-hour grace period), and manages execution lifecycle.
 */

import { createComponentLogger } from "#logging.js";
import type {
  RecurringTask,
  RecurringEvent,
  RecurringSchedulerConfig,
  TaskSchedule,
} from "../recurring-types.js";
import {
  getDueRecurringTasks,
  getRecurringTask,
  clearMissedPrompt,
  recordSuccess,
  recordFailure,
  recordMissed,
} from "./crud.js";
import { calculateNextRun } from "./schedule-calc.js";
import { scheduleNextPoll } from "./timer.js";

const log = createComponentLogger("recurring.execution");

const activeExecutions = new Set<string>();

/** Get the count of currently active executions. */
export function getActiveExecutionCount(): number {
  return activeExecutions.size;
}

/** Check if a specific task is currently executing. */
export function isExecuting(taskId: string): boolean {
  return activeExecutions.has(taskId);
}

/** Drain active executions (wait up to timeoutMs). */
export async function drainActiveExecutions(timeoutMs = 30_000): Promise<number> {
  if (activeExecutions.size === 0) return 0;

  log.info("Recurring scheduler draining", { count: activeExecutions.size });
  const drainStart = Date.now();
  while (activeExecutions.size > 0 && Date.now() - drainStart < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (activeExecutions.size > 0) {
    log.warn("Drain timed out", { remaining: activeExecutions.size });
  }
  return activeExecutions.size;
}

// ============================================
// POLLING
// ============================================

let polling = false;

export async function pollDueTasks(
  config: RecurringSchedulerConfig,
  executeCallback: ((task: RecurringTask) => Promise<string>) | null,
  emitEvent: (event: RecurringEvent) => void,
): Promise<void> {
  if (polling) return;
  polling = true;

  try {
    const dueTasks = getDueRecurringTasks();
    if (dueTasks.length === 0) return;

    log.debug(`Found ${dueTasks.length} due recurring tasks`);

    const now = new Date();
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

    for (const task of dueTasks) {
      // Don't re-execute already running tasks
      if (activeExecutions.has(task.id)) continue;

      // Calculate how overdue this task is
      const overdueMs = now.getTime() - task.nextRunAt.getTime();

      // Missed task (overdue > 2 hours)
      if (overdueMs > TWO_HOURS_MS) {
        // Only ask once per missed occurrence
        if (!task.missedPromptSentAt) {
          handleMissedTask(task, emitEvent);
        }
        // Skip execution — user must manually trigger if they want it
        continue;
      }

      // Due task (within 2-hour grace period) — check client connectivity first
      // CRITICAL: Scheduled tasks require client to be connected because credentials
      // use split-knowledge architecture (encrypted blob on client, decryption key on server)
      const { getDeviceForUser } = await import("#ws/devices.js");
      const deviceId = getDeviceForUser(task.userId);
      if (!deviceId) {
        // Client offline - skip for now, will retry on next poll
        // If it stays offline beyond 2 hours, the next poll will catch it as "missed"
        log.debug("Skipping recurring task - client offline (will retry)", {
          taskId: task.id,
          name: task.name,
          overdueMinutes: (overdueMs / 60000).toFixed(1),
        });
        continue;
      }

      // Respect concurrency limit
      if (activeExecutions.size >= config.maxConcurrent) {
        log.debug("Max concurrent recurring executions reached");
        break;
      }

      // Execute (non-blocking — don't await, let concurrent tasks proceed)
      executeRecurringTask(task, executeCallback, emitEvent);
    }
  } catch (error) {
    log.error("Error polling recurring tasks", { error });
  } finally {
    polling = false;
  }
}

// ============================================
// MISSED TASK HANDLING
// ============================================

/**
 * Handle a missed task (overdue > 2 hours).
 * Emits a "recurring_missed" event asking the user if they want to run it,
 * then advances nextRunAt to prevent pileup.
 */
function handleMissedTask(
  task: RecurringTask,
  emitEvent: (event: RecurringEvent) => void,
): void {
  const now = new Date();

  log.info("Recurring task missed (beyond 2-hour grace period)", {
    taskId: task.id,
    name: task.name,
    nextRunAt: task.nextRunAt.toISOString(),
    overdueHours: ((now.getTime() - task.nextRunAt.getTime()) / (60 * 60 * 1000)).toFixed(1),
  });

  // Advance next_run_at to prevent pileup (don't run all missed occurrences)
  const schedule: TaskSchedule = {
    type: task.scheduleType,
    time: task.scheduleTime || undefined,
    dayOfWeek: task.scheduleDayOfWeek ?? undefined,
    intervalMinutes: task.scheduleIntervalMinutes ?? undefined,
  };
  const nextRun = calculateNextRun(schedule, now, task.timezone);

  recordMissed(task.id, nextRun);

  // Emit event — listeners can send a message to the user asking if they want to run it
  emitEvent({
    type: "recurring_missed",
    taskId: task.id,
    userId: task.userId,
    taskName: task.name,
    timestamp: now,
    details: {
      prompt: task.prompt,
      overdueHours: ((now.getTime() - task.nextRunAt.getTime()) / (60 * 60 * 1000)).toFixed(1),
      nextRunAt: nextRun.toISOString(),
    },
  });

  // Re-arm timer — next_run_at was advanced
  scheduleNextPoll();
}

// ============================================
// EXECUTION
// ============================================

/**
 * Manually execute a missed task (user confirmed they want to run it).
 * This triggers execution immediately without waiting for the next scheduled time.
 */
export async function executeRecurringTaskNow(
  taskId: string,
  userId: string,
  executeCallback: ((task: RecurringTask) => Promise<string>) | null,
  emitEvent: (event: RecurringEvent) => void,
): Promise<boolean> {
  const task = getRecurringTask(taskId);
  if (!task || task.userId !== userId) return false;

  clearMissedPrompt(taskId);

  // Execute immediately (if not already running)
  if (!activeExecutions.has(task.id)) {
    const refreshedTask = getRecurringTask(taskId);
    if (refreshedTask) {
      executeRecurringTask(refreshedTask, executeCallback, emitEvent);
      return true;
    }
  }

  return false;
}

async function executeRecurringTask(
  task: RecurringTask,
  executeCallback: ((task: RecurringTask) => Promise<string>) | null,
  emitEvent: (event: RecurringEvent) => void,
): Promise<void> {
  if (!executeCallback) {
    log.warn("No execute callback set for recurring tasks", { taskId: task.id });
    return;
  }

  // NOTE: Client connectivity is checked in pollDueTasks() before calling this function
  // This ensures the 2-hour grace period logic works correctly:
  // - Task due but client offline: skip and retry on next poll (30s)
  // - Client reconnects < 2 hours: executes automatically
  // - Client reconnects > 2 hours: marked as missed, user prompted

  activeExecutions.add(task.id);

  emitEvent({
    type: "recurring_executing",
    taskId: task.id,
    userId: task.userId,
    taskName: task.name,
    timestamp: new Date(),
  });

  try {
    log.info("Executing recurring task", {
      taskId: task.id,
      name: task.name,
      promptLength: task.prompt.length,
    });

    const result = await executeCallback(task);

    // Success: update result, advance next_run_at, reset failures
    const schedule: TaskSchedule = {
      type: task.scheduleType,
      time: task.scheduleTime || undefined,
      dayOfWeek: task.scheduleDayOfWeek ?? undefined,
      intervalMinutes: task.scheduleIntervalMinutes ?? undefined,
    };
    const nextRun = calculateNextRun(schedule, new Date(), task.timezone);

    recordSuccess(task, result, nextRun);

    log.info("Recurring task completed", {
      taskId: task.id,
      name: task.name,
      nextRun: nextRun.toISOString(),
    });

    emitEvent({
      type: "recurring_completed",
      taskId: task.id,
      userId: task.userId,
      taskName: task.name,
      timestamp: new Date(),
      details: {
        resultLength: result.length,
        nextRunAt: nextRun.toISOString(),
      },
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Advance next_run_at regardless of failure (don't pile up)
    const schedule: TaskSchedule = {
      type: task.scheduleType,
      time: task.scheduleTime || undefined,
      dayOfWeek: task.scheduleDayOfWeek ?? undefined,
      intervalMinutes: task.scheduleIntervalMinutes ?? undefined,
    };
    const nextRun = calculateNextRun(schedule, new Date(), task.timezone);

    const { autoPaused, newFailures } = recordFailure(task, errorMsg, nextRun);

    if (autoPaused) {
      log.warn("Recurring task auto-paused", {
        taskId: task.id,
        name: task.name,
        failures: newFailures,
        error: errorMsg,
      });

      emitEvent({
        type: "recurring_paused",
        taskId: task.id,
        userId: task.userId,
        taskName: task.name,
        timestamp: new Date(),
        details: {
          reason: "auto_pause",
          failures: newFailures,
          error: errorMsg,
        },
      });
    } else {
      log.warn("Recurring task failed", {
        taskId: task.id,
        name: task.name,
        failures: newFailures,
        maxFailures: task.maxFailures,
        error: errorMsg,
        nextRun: nextRun.toISOString(),
      });

      emitEvent({
        type: "recurring_failed",
        taskId: task.id,
        userId: task.userId,
        taskName: task.name,
        timestamp: new Date(),
        details: {
          failures: newFailures,
          error: errorMsg,
          nextRunAt: nextRun.toISOString(),
        },
      });
    }
  } finally {
    activeExecutions.delete(task.id);
    // Re-arm timer — next_run_at was advanced
    scheduleNextPoll();
  }
}
