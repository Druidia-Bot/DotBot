/**
 * Deferred Tasks — Polling & Execution
 *
 * Polls for due tasks, respects concurrency limits, handles retries
 * with exponential backoff, and expires stale tasks.
 */

import { createComponentLogger } from "#logging.js";
import type { DeferredTask, SchedulerConfig, SchedulerEvent } from "../types.js";
import {
  getDueTasks,
  getTask,
  markExecuting,
  markCompleted,
  markFailed,
  markExpired,
  rescheduleForRetry,
} from "./crud.js";
import { scheduleNextPoll } from "./timer.js";

const log = createComponentLogger("scheduler.execution");

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

  log.info("Draining active executions", { count: activeExecutions.size });
  const drainStart = Date.now();
  while (activeExecutions.size > 0 && Date.now() - drainStart < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (activeExecutions.size > 0) {
    log.warn("Drain timed out, abandoning tasks", { remaining: activeExecutions.size });
  }
  return activeExecutions.size;
}

// ============================================
// POLLING
// ============================================

let polling = false;

export async function pollDueTasks(
  config: SchedulerConfig,
  executeCallback: ((task: DeferredTask) => Promise<string>) | null,
  emitEvent: (event: SchedulerEvent) => void,
): Promise<void> {
  if (polling) return;
  polling = true;

  try {
    const dueTasks = getDueTasks();
    if (dueTasks.length === 0) return;

    log.debug(`Found ${dueTasks.length} due tasks`);

    const now = new Date();
    for (const task of dueTasks) {
      const age = now.getTime() - task.createdAt.getTime();
      if (age > config.expirationMs) {
        expireTask(task, emitEvent);
        continue;
      }

      if (activeExecutions.size >= config.maxConcurrent) {
        log.debug("Max concurrent executions reached, skipping remaining");
        break;
      }

      if (activeExecutions.has(task.id)) continue;

      executeTask(task, executeCallback, emitEvent);
    }
  } catch (error) {
    log.error("Error polling due tasks", { error });
  } finally {
    polling = false;
  }
}

// ============================================
// EXECUTION
// ============================================

async function executeTask(
  task: DeferredTask,
  executeCallback: ((task: DeferredTask) => Promise<string>) | null,
  emitEvent: (event: SchedulerEvent) => void,
): Promise<void> {
  if (!executeCallback) {
    log.warn("No execute callback set, cannot run deferred task", { taskId: task.id });
    return;
  }

  activeExecutions.add(task.id);

  markExecuting(task.id);

  emitEvent({
    type: "task_executing",
    taskId: task.id,
    userId: task.userId,
    timestamp: new Date(),
    details: { attemptCount: task.attemptCount + 1 },
  });

  try {
    log.info("Executing deferred task", {
      taskId: task.id,
      attempt: task.attemptCount + 1,
      prompt: task.originalPrompt.substring(0, 80),
    });

    const result = await executeCallback(task);

    markCompleted(task.id, result);

    log.info("Deferred task completed", { taskId: task.id });

    emitEvent({
      type: "task_completed",
      taskId: task.id,
      userId: task.userId,
      timestamp: new Date(),
      details: { resultLength: result.length },
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";

    if (task.attemptCount + 1 >= task.maxAttempts) {
      markFailed(task.id, errorMsg);

      log.error("Deferred task failed permanently", {
        taskId: task.id,
        attempts: task.attemptCount + 1,
        error: errorMsg,
      });

      emitEvent({
        type: "task_failed",
        taskId: task.id,
        userId: task.userId,
        timestamp: new Date(),
        details: { error: errorMsg, attempts: task.attemptCount + 1 },
      });
    } else {
      // Retry — reschedule with exponential backoff
      const backoffMs = Math.min(
        30_000 * Math.pow(2, task.attemptCount),
        600_000 // Max 10 min backoff
      );
      const retryAt = new Date(Date.now() + backoffMs);

      rescheduleForRetry(task.id, retryAt, errorMsg);

      log.warn("Deferred task failed, rescheduled", {
        taskId: task.id,
        attempt: task.attemptCount + 1,
        retryAt: retryAt.toISOString(),
        error: errorMsg,
      });
    }
  } finally {
    activeExecutions.delete(task.id);
    scheduleNextPoll();
  }
}

// ============================================
// EXPIRATION
// ============================================

function expireTask(
  task: DeferredTask,
  emitEvent: (event: SchedulerEvent) => void,
): void {
  markExpired(task.id);

  log.info("Deferred task expired", { taskId: task.id });

  emitEvent({
    type: "task_expired",
    taskId: task.id,
    userId: task.userId,
    timestamp: new Date(),
  });
}
