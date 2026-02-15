/**
 * Recurring Tasks — CRUD
 *
 * Create, read, update operations for recurring tasks in SQLite.
 */

import { nanoid } from "nanoid";
import * as db from "../../../db/index.js";
import { createComponentLogger } from "#logging.js";
import type {
  RecurringTask,
  CreateRecurringTaskParams,
  RecurringSchedulerConfig,
  TaskSchedule,
} from "../recurring-types.js";
import { calculateNextRun } from "./schedule-calc.js";

const log = createComponentLogger("recurring.crud");

// ============================================
// ROW MAPPING
// ============================================

export function rowToTask(row: any): RecurringTask {
  return {
    id: row.id,
    userId: row.user_id,
    deviceId: row.device_id || null,
    name: row.name,
    prompt: row.prompt,
    personaHint: row.persona_hint || null,
    scheduleType: row.schedule_type,
    scheduleTime: row.schedule_time || null,
    scheduleDayOfWeek: row.schedule_day_of_week ?? null,
    scheduleIntervalMinutes: row.schedule_interval_minutes ?? null,
    timezone: row.timezone || "UTC",
    priority: row.priority,
    status: row.status,
    lastRunAt: row.last_run_at ? new Date(row.last_run_at) : null,
    nextRunAt: new Date(row.next_run_at),
    lastResult: row.last_result || null,
    lastError: row.last_error || null,
    consecutiveFailures: row.consecutive_failures,
    maxFailures: row.max_failures,
    missedPromptSentAt: row.missed_prompt_sent_at ? new Date(row.missed_prompt_sent_at) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

// ============================================
// CREATE
// ============================================

/**
 * Create a new recurring task.
 */
export function insertRecurringTask(
  params: CreateRecurringTaskParams,
  defaultMaxFailures: number,
): RecurringTask {
  const database = db.getDatabase();
  const id = `rsched_${nanoid(12)}`;
  const now = new Date();
  const tz = params.timezone || "UTC";

  const nextRun = calculateNextRun(params.schedule, now, tz);

  const task: RecurringTask = {
    id,
    userId: params.userId,
    deviceId: params.deviceId || null,
    name: params.name,
    prompt: params.prompt,
    personaHint: params.personaHint || null,
    scheduleType: params.schedule.type,
    scheduleTime: params.schedule.time || null,
    scheduleDayOfWeek: params.schedule.dayOfWeek ?? null,
    scheduleIntervalMinutes: params.schedule.intervalMinutes ?? null,
    timezone: tz,
    priority: params.priority || "P2",
    status: "active",
    lastRunAt: null,
    nextRunAt: nextRun,
    lastResult: null,
    lastError: null,
    consecutiveFailures: 0,
    maxFailures: params.maxFailures ?? defaultMaxFailures,
    missedPromptSentAt: null,
    createdAt: now,
    updatedAt: now,
  };

  database.prepare(`
    INSERT INTO recurring_tasks
      (id, user_id, device_id, name, prompt, persona_hint,
       schedule_type, schedule_time, schedule_day_of_week, schedule_interval_minutes,
       timezone, priority, status, next_run_at, consecutive_failures, max_failures,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.userId,
    task.deviceId,
    task.name,
    task.prompt,
    task.personaHint,
    task.scheduleType,
    task.scheduleTime,
    task.scheduleDayOfWeek,
    task.scheduleIntervalMinutes,
    task.timezone,
    task.priority,
    task.status,
    task.nextRunAt.toISOString(),
    task.consecutiveFailures,
    task.maxFailures,
    task.createdAt.toISOString(),
    task.updatedAt.toISOString()
  );

  log.info("Recurring task created", {
    id: task.id,
    name: task.name,
    type: task.scheduleType,
    nextRun: task.nextRunAt.toISOString(),
  });

  return task;
}

// ============================================
// READ
// ============================================

/**
 * Get a single recurring task by ID.
 */
export function getRecurringTask(taskId: string): RecurringTask | null {
  const database = db.getDatabase();
  const row = database
    .prepare("SELECT * FROM recurring_tasks WHERE id = ?")
    .get(taskId) as any;
  return row ? rowToTask(row) : null;
}

/**
 * List recurring tasks for a user, optionally filtered by status.
 */
export function listRecurringTasks(
  userId: string,
  statusFilter?: string
): RecurringTask[] {
  const database = db.getDatabase();
  let query = "SELECT * FROM recurring_tasks WHERE user_id = ?";
  const params: any[] = [userId];

  if (statusFilter) {
    query += " AND status = ?";
    params.push(statusFilter);
  }

  query += " ORDER BY next_run_at ASC";
  const rows = database.prepare(query).all(...params) as any[];
  return rows.map(rowToTask);
}

/**
 * Get due recurring tasks (next_run_at <= now, status = active).
 */
export function getDueRecurringTasks(): RecurringTask[] {
  const database = db.getDatabase();
  const now = new Date().toISOString();

  const rows = database.prepare(`
    SELECT * FROM recurring_tasks
    WHERE status = 'active' AND next_run_at <= ?
    ORDER BY
      CASE priority
        WHEN 'P0' THEN 0
        WHEN 'P1' THEN 1
        WHEN 'P2' THEN 2
        WHEN 'P3' THEN 3
      END,
      next_run_at ASC
  `).all(now) as any[];

  return rows.map(rowToTask);
}

/**
 * Get tasks that ran while a device was offline.
 */
export function getOfflineResults(
  userId: string,
  deviceLastSeen: Date
): RecurringTask[] {
  const database = db.getDatabase();
  const rows = database.prepare(`
    SELECT * FROM recurring_tasks
    WHERE user_id = ? AND last_result IS NOT NULL
      AND last_run_at > ?
    ORDER BY last_run_at DESC
  `).all(userId, deviceLastSeen.toISOString()) as any[];
  return rows.map(rowToTask);
}

/**
 * Get upcoming tasks for a user (for heartbeat awareness).
 */
export function getUpcomingRecurringTasks(
  userId: string,
  withinMs: number = 3_600_000
): RecurringTask[] {
  const database = db.getDatabase();
  const cutoff = new Date(Date.now() + withinMs).toISOString();
  const rows = database.prepare(`
    SELECT * FROM recurring_tasks
    WHERE user_id = ? AND status = 'active' AND next_run_at <= ?
    ORDER BY next_run_at ASC
  `).all(userId, cutoff) as any[];
  return rows.map(rowToTask);
}

// ============================================
// UPDATE
// ============================================

/**
 * Cancel a recurring task. Returns true if a task was actually cancelled.
 */
export function cancelRecurringTaskInDb(taskId: string, userId: string): boolean {
  const database = db.getDatabase();
  const result = database.prepare(`
    UPDATE recurring_tasks SET status = 'cancelled', updated_at = ?
    WHERE id = ? AND user_id = ? AND status != 'cancelled'
  `).run(new Date().toISOString(), taskId, userId);

  if (result.changes > 0) {
    log.info("Recurring task cancelled", { taskId });
    return true;
  }
  return false;
}

/**
 * Pause a recurring task. Returns true if a task was actually paused.
 */
export function pauseRecurringTaskInDb(taskId: string, userId: string): boolean {
  const database = db.getDatabase();
  const result = database.prepare(`
    UPDATE recurring_tasks SET status = 'paused', updated_at = ?
    WHERE id = ? AND user_id = ? AND status = 'active'
  `).run(new Date().toISOString(), taskId, userId);

  if (result.changes > 0) {
    log.info("Recurring task paused", { taskId });
    return true;
  }
  return false;
}

/**
 * Resume a paused recurring task. Resets failures and recalculates next run.
 * Returns the new next run time, or null if the task couldn't be resumed.
 */
export function resumeRecurringTaskInDb(taskId: string, userId: string): Date | null {
  const database = db.getDatabase();
  const task = getRecurringTask(taskId);
  if (!task || task.userId !== userId || task.status !== "paused") return null;

  const schedule: TaskSchedule = {
    type: task.scheduleType,
    time: task.scheduleTime || undefined,
    dayOfWeek: task.scheduleDayOfWeek ?? undefined,
    intervalMinutes: task.scheduleIntervalMinutes ?? undefined,
  };
  const nextRun = calculateNextRun(schedule, new Date(), task.timezone);

  database.prepare(`
    UPDATE recurring_tasks
    SET status = 'active', consecutive_failures = 0, last_error = NULL,
        missed_prompt_sent_at = NULL, next_run_at = ?, updated_at = ?
    WHERE id = ?
  `).run(nextRun.toISOString(), new Date().toISOString(), taskId);

  log.info("Recurring task resumed", { taskId, nextRun: nextRun.toISOString() });

  return nextRun;
}

/**
 * Clear the missed prompt flag for a task.
 */
export function clearMissedPrompt(taskId: string): void {
  const database = db.getDatabase();
  database.prepare(`
    UPDATE recurring_tasks
    SET missed_prompt_sent_at = NULL, updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), taskId);
}

/**
 * Record a successful execution: update result, advance next_run_at, reset failures.
 */
export function recordSuccess(task: RecurringTask, result: string, nextRun: Date): void {
  const database = db.getDatabase();
  const now = new Date().toISOString();
  database.prepare(`
    UPDATE recurring_tasks
    SET last_run_at = ?, last_result = ?, last_error = NULL,
        consecutive_failures = 0, missed_prompt_sent_at = NULL,
        next_run_at = ?, updated_at = ?
    WHERE id = ?
  `).run(now, result.substring(0, 5000), nextRun.toISOString(), now, task.id);
}

/**
 * Record a failed execution. If max failures reached, auto-pause.
 */
export function recordFailure(
  task: RecurringTask,
  error: string,
  nextRun: Date,
): { autoPaused: boolean; newFailures: number } {
  const database = db.getDatabase();
  const newFailures = task.consecutiveFailures + 1;
  const now = new Date().toISOString();

  if (newFailures >= task.maxFailures) {
    database.prepare(`
      UPDATE recurring_tasks
      SET last_run_at = ?, last_error = ?, consecutive_failures = ?,
          status = 'paused', next_run_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, error, newFailures, nextRun.toISOString(), now, task.id);
    return { autoPaused: true, newFailures };
  } else {
    database.prepare(`
      UPDATE recurring_tasks
      SET last_run_at = ?, last_error = ?, consecutive_failures = ?,
          next_run_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, error, newFailures, nextRun.toISOString(), now, task.id);
    return { autoPaused: false, newFailures };
  }
}

/**
 * Record a missed task: set missed_prompt_sent_at and advance next_run_at.
 */
export function recordMissed(taskId: string, nextRun: Date): void {
  const database = db.getDatabase();
  const now = new Date().toISOString();
  database.prepare(`
    UPDATE recurring_tasks
    SET missed_prompt_sent_at = ?, next_run_at = ?, updated_at = ?
    WHERE id = ?
  `).run(now, nextRun.toISOString(), now, taskId);
}

/**
 * Prune cancelled tasks older than 7 days.
 * Called periodically (e.g., once on startup).
 */
export function pruneOldCancelledTasks(): void {
  try {
    const database = db.getDatabase();
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const result = database.prepare(`
      DELETE FROM recurring_tasks
      WHERE status = 'cancelled' AND created_at < ?
    `).run(cutoff);

    if (result.changes > 0) {
      log.info("Pruned old cancelled recurring tasks", { count: result.changes });
    }
  } catch (error) {
    log.error("Failed to prune cancelled tasks", { error });
  }
}
