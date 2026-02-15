/**
 * Deferred Tasks — Service (Lifecycle Orchestrator)
 *
 * Thin orchestrator that wires together schema, CRUD, timer, and execution.
 * Owns the start/stop lifecycle and event emission.
 */

import { createComponentLogger } from "#logging.js";
import type {
  DeferredTask,
  SchedulerEvent,
  SchedulerEventCallback,
  SchedulerConfig,
} from "../types.js";
import { DEFAULT_SCHEDULER_CONFIG } from "../types.js";
import { ensureDeferredSchema } from "./schema.js";
import { insertTask, getTask, cancelTaskInDb } from "./crud.js";
import { setTimerRunning, setPollCallback, scheduleNextPoll } from "./timer.js";
import { pollDueTasks, drainActiveExecutions } from "./execution.js";

const log = createComponentLogger("scheduler");

// ============================================
// STATE
// ============================================

let config: SchedulerConfig = { ...DEFAULT_SCHEDULER_CONFIG };
let running = false;
const eventListeners: SchedulerEventCallback[] = [];

/** Callback to re-execute a deferred task */
let executeCallback: ((task: DeferredTask) => Promise<string>) | null = null;

// ============================================
// INITIALIZATION
// ============================================

/**
 * Start the scheduler with optional configuration overrides.
 */
export function startScheduler(overrides?: Partial<SchedulerConfig>): void {
  if (running) {
    log.warn("Scheduler already running");
    return;
  }

  config = { ...DEFAULT_SCHEDULER_CONFIG, ...overrides };
  running = true;

  ensureDeferredSchema();
  setTimerRunning(true);
  setPollCallback(() => pollDueTasks(config, executeCallback, emitEvent));

  log.info("Scheduler started", {
    maxConcurrent: config.maxConcurrent,
  });

  // Run an immediate poll, then arm the timer wheel
  pollDueTasks(config, executeCallback, emitEvent).then(() => scheduleNextPoll());
}

/**
 * Stop the scheduler gracefully.
 */
export async function stopScheduler(): Promise<void> {
  if (!running) return;

  running = false;
  setTimerRunning(false);

  const remaining = await drainActiveExecutions(30_000);
  log.info("Scheduler stopped", { activeExecutions: remaining });
}

/**
 * Set the callback used to re-execute deferred tasks.
 */
export function setExecuteCallback(
  callback: (task: DeferredTask) => Promise<string>
): void {
  executeCallback = callback;
}

/**
 * Register a listener for scheduler events.
 */
export function onSchedulerEvent(callback: SchedulerEventCallback): void {
  eventListeners.push(callback);
}

// ============================================
// PUBLIC TASK API (delegates to CRUD + events)
// ============================================

/**
 * Schedule a deferred task.
 */
export function scheduleTask(params: {
  userId: string;
  sessionId: string;
  originalPrompt: string;
  deferredBy: string;
  deferReason: string;
  scheduledFor: Date;
  priority?: "P0" | "P1" | "P2" | "P3";
  maxAttempts?: number;
  context?: Record<string, unknown>;
  threadIds?: string[];
}): DeferredTask {
  const task = insertTask(params, config.defaultMaxAttempts);

  emitEvent({
    type: "task_scheduled",
    taskId: task.id,
    userId: task.userId,
    timestamp: new Date(),
    details: {
      scheduledFor: task.scheduledFor.toISOString(),
      deferredBy: task.deferredBy,
      reason: task.deferReason,
      priority: task.priority,
    },
  });

  // Re-arm timer — this new task might be sooner than the current timer
  scheduleNextPoll();

  return task;
}

/**
 * Cancel a scheduled task.
 */
export function cancelTask(taskId: string): boolean {
  const cancelled = cancelTaskInDb(taskId);
  if (cancelled) {
    const task = getTask(taskId);
    if (task) {
      emitEvent({
        type: "task_cancelled",
        taskId,
        userId: task.userId,
        timestamp: new Date(),
      });
    }
    // Re-arm timer — the cancelled task may have been the next due
    scheduleNextPoll();
  }
  return cancelled;
}

// ============================================
// EVENT EMISSION
// ============================================

function emitEvent(event: SchedulerEvent): void {
  for (const listener of eventListeners) {
    try {
      listener(event);
    } catch (error) {
      log.error("Event listener error", { error });
    }
  }
}
