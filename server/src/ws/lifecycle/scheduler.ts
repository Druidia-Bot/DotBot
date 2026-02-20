/**
 * Scheduler Wiring
 *
 * Connects the deferred and recurring task schedulers to the
 * WebSocket prompt pipeline. Tasks are executed as synthetic
 * prompts through the V2 pipeline.
 */

import { nanoid } from "nanoid";
import type { WSPromptMessage } from "../../types.js";
import { getDeviceForUser, broadcastToUser } from "../devices.js";
import { handlePrompt } from "../handlers/prompt.js";
import {
  setExecuteCallback,
  onSchedulerEvent,
  setRecurringExecuteCallback,
  onRecurringEvent,
} from "../../services/scheduler/index.js";
import type { DeferredTask, RecurringTask } from "../../services/scheduler/index.js";
import { createComponentLogger } from "#logging.js";

const log = createComponentLogger("ws.scheduler");

/** Max time a scheduled task can run before being killed. */
const TASK_EXECUTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Race a promise against a timeout. Rejects with a clear error if the timeout fires first. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Scheduled task "${label}" timed out after ${ms / 1000}s`));
    }, ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Wire both deferred and recurring schedulers to the prompt pipeline.
 * Must be called once during server creation.
 */
export function wireSchedulers(apiKey: string, provider: string): void {
  wireDeferredScheduler(apiKey, provider);
  wireRecurringScheduler(apiKey, provider);
  wireSchedulerEvents();
  wireRecurringEvents();
}

// ── Deferred Tasks ──

function wireDeferredScheduler(apiKey: string, provider: string): void {
  setExecuteCallback(async (task: DeferredTask) => {
    const deviceId = getDeviceForUser(task.userId);
    if (!deviceId) {
      throw new Error(`User ${task.userId} has no connected device — cannot execute deferred task`);
    }

    const syntheticMessage: WSPromptMessage = {
      type: "prompt" as const,
      id: `sched_${task.id}`,
      timestamp: Date.now(),
      payload: {
        prompt: `[Scheduled Task — ${task.deferReason}] ${task.originalPrompt}`,
        source: "scheduler",
      },
    };

    log.info("Executing deferred task via prompt pipeline", {
      taskId: task.id,
      userId: task.userId,
      deviceId,
      prompt: task.originalPrompt.substring(0, 80),
    });

    await withTimeout(
      handlePrompt(deviceId, syntheticMessage, apiKey, provider),
      TASK_EXECUTION_TIMEOUT_MS,
      task.originalPrompt.substring(0, 60),
    );
    return `Deferred task ${task.id} executed via prompt pipeline`;
  });
}

// ── Recurring Tasks ──

function wireRecurringScheduler(apiKey: string, provider: string): void {
  setRecurringExecuteCallback(async (task: RecurringTask) => {
    const deviceId = getDeviceForUser(task.userId);

    const syntheticMessage: WSPromptMessage = {
      type: "prompt" as const,
      id: `rsched_${task.id}`,
      timestamp: Date.now(),
      payload: {
        prompt: task.prompt,
        source: "scheduled_task",
        hints: task.personaHint ? { personaHint: task.personaHint } : undefined,
      },
    };

    if (!deviceId) {
      log.warn("Recurring task execution skipped - no connected device", {
        taskId: task.id,
        name: task.name,
        userId: task.userId,
        nextRetry: "Will retry on next schedule interval",
      });
      throw new Error(`No device connected for user ${task.userId} — task "${task.name}" will retry on next interval`);
    }

    log.info("Executing recurring task via V2 pipeline", {
      taskId: task.id,
      name: task.name,
      userId: task.userId,
      deviceId,
      flow: "handlePrompt → receptionist → persona writer → orchestrator → judge",
    });

    await withTimeout(
      handlePrompt(deviceId, syntheticMessage, apiKey, provider),
      TASK_EXECUTION_TIMEOUT_MS,
      task.name,
    );
    return `Recurring task "${task.name}" executed successfully via V2 pipeline`;
  });
}

// ── Event Routing ──

function wireRecurringEvents(): void {
  onRecurringEvent((event) => {
    if (!["recurring_completed", "recurring_failed", "recurring_paused"].includes(event.type)) return;

    const labels: Record<string, string> = {
      recurring_completed: `"${event.taskName}" completed`,
      recurring_failed: `"${event.taskName}" failed`,
      recurring_paused: `"${event.taskName}" paused (repeated failures)`,
    };

    broadcastToUser(event.userId, {
      type: "user_notification",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        source: "recurring_scheduler",
        level: event.type === "recurring_completed" ? "info" : "warning",
        title: labels[event.type] || event.type,
        taskId: event.taskId,
        taskName: event.taskName,
        details: event.details,
      },
    });
  });
}

function wireSchedulerEvents(): void {
  onSchedulerEvent((event) => {
    if (!["task_completed", "task_failed", "task_expired"].includes(event.type)) return;

    const labels: Record<string, string> = {
      task_completed: "Scheduled task completed",
      task_failed: "Scheduled task failed",
      task_expired: "Scheduled task expired",
    };

    broadcastToUser(event.userId, {
      type: "user_notification",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        source: "scheduler",
        level: event.type === "task_completed" ? "info" : "warning",
        title: labels[event.type] || event.type,
        taskId: event.taskId,
        details: event.details,
      },
    });
  });
}
