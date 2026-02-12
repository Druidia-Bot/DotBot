/**
 * Scheduler Service
 * 
 * Production-grade task deferral and scheduling system.
 * 
 * Responsibilities:
 * - Accept deferred tasks from persona responses
 * - Persist them to SQLite via the DB layer
 * - Poll for due tasks on an interval
 * - Re-execute deferred tasks when their time arrives
 * - Notify clients of task status changes
 * - Handle retries, expiration, and cancellation
 */

import { nanoid } from "nanoid";
import * as db from "../db/index.js";
import { createComponentLogger } from "../logging.js";
import type {
  DeferredTask,
  SchedulerEvent,
  SchedulerEventCallback,
  SchedulerConfig,
} from "./types.js";
import { DEFAULT_SCHEDULER_CONFIG } from "./types.js";

const log = createComponentLogger("scheduler");

// ============================================
// STATE
// ============================================

let config: SchedulerConfig = { ...DEFAULT_SCHEDULER_CONFIG };
let pollTimer: ReturnType<typeof setInterval> | null = null;
let running = false;
let polling = false;
const activeExecutions = new Set<string>();
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

  // Ensure the deferred_tasks table exists
  ensureSchema();

  log.info("Scheduler started", {
    pollIntervalMs: config.pollIntervalMs,
    maxConcurrent: config.maxConcurrent,
  });

  // Start polling
  pollTimer = setInterval(pollDueTasks, config.pollIntervalMs);

  // Run an immediate poll
  pollDueTasks();
}

/**
 * Stop the scheduler gracefully.
 */
export async function stopScheduler(): Promise<void> {
  if (!running) return;

  running = false;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // Drain active executions (wait up to 30s)
  if (activeExecutions.size > 0) {
    log.info("Scheduler draining active executions", { count: activeExecutions.size });
    const drainStart = Date.now();
    const drainTimeoutMs = 30_000;
    while (activeExecutions.size > 0 && Date.now() - drainStart < drainTimeoutMs) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (activeExecutions.size > 0) {
      log.warn("Scheduler drain timed out, abandoning tasks", { remaining: activeExecutions.size });
    }
  }

  log.info("Scheduler stopped", { activeExecutions: activeExecutions.size });
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
// SCHEMA
// ============================================

function ensureSchema(): void {
  try {
    const database = db.getDatabase();
    database.exec(`
      CREATE TABLE IF NOT EXISTS deferred_tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        original_prompt TEXT NOT NULL,
        deferred_by TEXT NOT NULL,
        defer_reason TEXT NOT NULL,
        scheduled_for DATETIME NOT NULL,
        attempt_count INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 3,
        priority TEXT DEFAULT 'P2',
        status TEXT DEFAULT 'scheduled',
        context TEXT,
        thread_ids TEXT,
        result TEXT,
        error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_deferred_scheduled 
        ON deferred_tasks(scheduled_for) WHERE status = 'scheduled';
      CREATE INDEX IF NOT EXISTS idx_deferred_user 
        ON deferred_tasks(user_id);
      CREATE INDEX IF NOT EXISTS idx_deferred_status 
        ON deferred_tasks(status);
    `);
  } catch (error) {
    log.error("Failed to ensure scheduler schema", { error });
  }
}

// ============================================
// TASK MANAGEMENT
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
  const database = db.getDatabase();
  const id = `defer_${nanoid(12)}`;
  const now = new Date();

  const task: DeferredTask = {
    id,
    userId: params.userId,
    sessionId: params.sessionId,
    originalPrompt: params.originalPrompt,
    deferredBy: params.deferredBy,
    deferReason: params.deferReason,
    scheduledFor: params.scheduledFor,
    attemptCount: 0,
    maxAttempts: params.maxAttempts || config.defaultMaxAttempts,
    priority: params.priority || "P2",
    status: "scheduled",
    context: params.context,
    threadIds: params.threadIds,
    createdAt: now,
    updatedAt: now,
  };

  database.prepare(`
    INSERT INTO deferred_tasks 
      (id, user_id, session_id, original_prompt, deferred_by, defer_reason,
       scheduled_for, attempt_count, max_attempts, priority, status,
       context, thread_ids, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.userId,
    task.sessionId,
    task.originalPrompt,
    task.deferredBy,
    task.deferReason,
    task.scheduledFor.toISOString(),
    task.attemptCount,
    task.maxAttempts,
    task.priority,
    task.status,
    task.context ? JSON.stringify(task.context) : null,
    task.threadIds ? JSON.stringify(task.threadIds) : null,
    task.createdAt.toISOString(),
    task.updatedAt.toISOString()
  );

  log.info("Task scheduled", {
    id: task.id,
    deferredBy: task.deferredBy,
    scheduledFor: task.scheduledFor.toISOString(),
    reason: task.deferReason,
  });

  emitEvent({
    type: "task_scheduled",
    taskId: task.id,
    userId: task.userId,
    timestamp: now,
    details: {
      scheduledFor: task.scheduledFor.toISOString(),
      deferredBy: task.deferredBy,
      reason: task.deferReason,
      priority: task.priority,
    },
  });

  return task;
}

/**
 * Cancel a scheduled task.
 */
export function cancelTask(taskId: string): boolean {
  const database = db.getDatabase();
  const result = database.prepare(`
    UPDATE deferred_tasks SET status = 'expired', updated_at = ?
    WHERE id = ? AND status = 'scheduled'
  `).run(new Date().toISOString(), taskId);

  if (result.changes > 0) {
    log.info("Task cancelled", { taskId });
    const task = getTask(taskId);
    if (task) {
      emitEvent({
        type: "task_cancelled",
        taskId,
        userId: task.userId,
        timestamp: new Date(),
      });
    }
    return true;
  }
  return false;
}

/**
 * Get a specific deferred task.
 */
export function getTask(taskId: string): DeferredTask | null {
  const database = db.getDatabase();
  const row = database.prepare("SELECT * FROM deferred_tasks WHERE id = ?").get(taskId) as any;
  return row ? rowToTask(row) : null;
}

/**
 * Get all deferred tasks for a user.
 */
export function getUserTasks(userId: string, statusFilter?: string): DeferredTask[] {
  const database = db.getDatabase();
  let query = "SELECT * FROM deferred_tasks WHERE user_id = ?";
  const params: any[] = [userId];

  if (statusFilter) {
    query += " AND status = ?";
    params.push(statusFilter);
  }

  query += " ORDER BY scheduled_for ASC";
  const rows = database.prepare(query).all(...params) as any[];
  return rows.map(rowToTask);
}

/**
 * Get tasks that are due for execution.
 */
export function getDueTasks(): DeferredTask[] {
  const database = db.getDatabase();
  const now = new Date().toISOString();

  const rows = database.prepare(`
    SELECT * FROM deferred_tasks 
    WHERE status = 'scheduled' AND scheduled_for <= ?
    ORDER BY 
      CASE priority 
        WHEN 'P0' THEN 0 
        WHEN 'P1' THEN 1 
        WHEN 'P2' THEN 2 
        WHEN 'P3' THEN 3 
      END,
      scheduled_for ASC
  `).all(now) as any[];

  return rows.map(rowToTask);
}

// ============================================
// POLLING & EXECUTION
// ============================================

async function pollDueTasks(): Promise<void> {
  if (!running || polling) return;
  polling = true;

  try {
    const dueTasks = getDueTasks();
    if (dueTasks.length === 0) return;

    log.debug(`Found ${dueTasks.length} due tasks`);

    // Expire old tasks
    const now = new Date();
    for (const task of dueTasks) {
      const age = now.getTime() - task.createdAt.getTime();
      if (age > config.expirationMs) {
        markExpired(task);
        continue;
      }

      // Respect concurrency limit
      if (activeExecutions.size >= config.maxConcurrent) {
        log.debug("Max concurrent executions reached, skipping remaining");
        break;
      }

      // Don't re-execute tasks already running
      if (activeExecutions.has(task.id)) continue;

      // Execute the task
      executeTask(task);
    }
  } catch (error) {
    log.error("Error polling due tasks", { error });
  } finally {
    polling = false;
  }
}

async function executeTask(task: DeferredTask): Promise<void> {
  if (!executeCallback) {
    log.warn("No execute callback set, cannot run deferred task", { taskId: task.id });
    return;
  }

  activeExecutions.add(task.id);
  const database = db.getDatabase();

  // Update status to executing
  database.prepare(`
    UPDATE deferred_tasks SET status = 'executing', attempt_count = attempt_count + 1, updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), task.id);

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

    // Mark completed
    database.prepare(`
      UPDATE deferred_tasks SET status = 'completed', result = ?, updated_at = ?
      WHERE id = ?
    `).run(result, new Date().toISOString(), task.id);

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
      // Max attempts reached — mark failed
      database.prepare(`
        UPDATE deferred_tasks SET status = 'failed', error = ?, updated_at = ?
        WHERE id = ?
      `).run(errorMsg, new Date().toISOString(), task.id);

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

      database.prepare(`
        UPDATE deferred_tasks SET status = 'scheduled', scheduled_for = ?, error = ?, updated_at = ?
        WHERE id = ?
      `).run(retryAt.toISOString(), errorMsg, new Date().toISOString(), task.id);

      log.warn("Deferred task failed, rescheduled", {
        taskId: task.id,
        attempt: task.attemptCount + 1,
        retryAt: retryAt.toISOString(),
        error: errorMsg,
      });
    }
  } finally {
    activeExecutions.delete(task.id);
  }
}

function markExpired(task: DeferredTask): void {
  const database = db.getDatabase();
  database.prepare(`
    UPDATE deferred_tasks SET status = 'expired', updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), task.id);

  log.info("Deferred task expired", { taskId: task.id });

  emitEvent({
    type: "task_expired",
    taskId: task.id,
    userId: task.userId,
    timestamp: new Date(),
  });
}

// ============================================
// STATS
// ============================================

export interface SchedulerStats {
  scheduled: number;
  executing: number;
  completed: number;
  failed: number;
  expired: number;
  activeExecutions: number;
}

export function getStats(): SchedulerStats {
  const database = db.getDatabase();

  const counts = database.prepare(`
    SELECT status, COUNT(*) as count FROM deferred_tasks GROUP BY status
  `).all() as { status: string; count: number }[];

  const stats: SchedulerStats = {
    scheduled: 0,
    executing: 0,
    completed: 0,
    failed: 0,
    expired: 0,
    activeExecutions: activeExecutions.size,
  };

  for (const row of counts) {
    if (row.status in stats) {
      (stats as any)[row.status] = row.count;
    }
  }

  return stats;
}

// ============================================
// HELPERS
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

function rowToTask(row: any): DeferredTask {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    originalPrompt: row.original_prompt,
    deferredBy: row.deferred_by,
    deferReason: row.defer_reason,
    scheduledFor: new Date(row.scheduled_for),
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    priority: row.priority,
    status: row.status,
    context: row.context ? JSON.parse(row.context) : undefined,
    threadIds: row.thread_ids ? JSON.parse(row.thread_ids) : undefined,
    result: row.result || undefined,
    error: row.error || undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * Parse a human-readable time expression into a Date.
 * Supports: "in 30 minutes", "at 1:15 PM", "in 2 hours", "tomorrow 10am", ISO strings.
 */
export function parseScheduleTime(expression: string): Date | null {
  const now = new Date();
  const lower = expression.trim().toLowerCase();

  // ISO date string
  if (/^\d{4}-\d{2}-\d{2}/.test(lower)) {
    const d = new Date(expression);
    return isNaN(d.getTime()) ? null : d;
  }

  // "in X minutes/hours/seconds"
  const relativeMatch = lower.match(/^in\s+(\d+)\s+(second|minute|hour|day)s?$/);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1]);
    const unit = relativeMatch[2];
    const ms = {
      second: 1000,
      minute: 60_000,
      hour: 3_600_000,
      day: 86_400_000,
    }[unit] || 60_000;
    return new Date(now.getTime() + amount * ms);
  }

  // "at HH:MM" or "at H:MM AM/PM"
  const atTimeMatch = lower.match(/^at\s+(\d{1,2}):(\d{2})\s*(am|pm)?$/);
  if (atTimeMatch) {
    let hours = parseInt(atTimeMatch[1]);
    const minutes = parseInt(atTimeMatch[2]);
    const ampm = atTimeMatch[3];

    if (ampm === "pm" && hours < 12) hours += 12;
    if (ampm === "am" && hours === 12) hours = 0;

    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);
    // If the time has already passed today, schedule for tomorrow
    if (target <= now) {
      target.setDate(target.getDate() + 1);
    }
    return target;
  }

  // "tomorrow" or "tomorrow at HH:MM"
  const tomorrowMatch = lower.match(/^tomorrow(?:\s+(?:at\s+)?(\d{1,2}):?(\d{2})?\s*(am|pm)?)?$/);
  if (tomorrowMatch) {
    const target = new Date(now);
    target.setDate(target.getDate() + 1);

    if (tomorrowMatch[1]) {
      let hours = parseInt(tomorrowMatch[1]);
      const minutes = parseInt(tomorrowMatch[2] || "0");
      const ampm = tomorrowMatch[3];

      if (ampm === "pm" && hours < 12) hours += 12;
      if (ampm === "am" && hours === 12) hours = 0;

      target.setHours(hours, minutes, 0, 0);
    } else {
      target.setHours(10, 0, 0, 0); // Default: tomorrow 10 AM
    }
    return target;
  }

  // Fallback: try to parse as-is
  const parsed = new Date(expression);
  return isNaN(parsed.getTime()) ? null : parsed;
}
