/**
 * Deferred Tasks — CRUD
 *
 * Create, read, update operations for deferred tasks in SQLite.
 */

import { nanoid } from "nanoid";
import * as db from "../../../db/index.js";
import { createComponentLogger } from "#logging.js";
import type { DeferredTask, SchedulerConfig } from "../types.js";

const log = createComponentLogger("scheduler.crud");

// ============================================
// ROW MAPPING
// ============================================

export function rowToTask(row: any): DeferredTask {
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

// ============================================
// CREATE
// ============================================

/**
 * Insert a deferred task into the database.
 */
export function insertTask(params: {
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
}, defaultMaxAttempts: number): DeferredTask {
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
    maxAttempts: params.maxAttempts || defaultMaxAttempts,
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

  return task;
}

// ============================================
// READ
// ============================================

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
// UPDATE
// ============================================

/**
 * Cancel a scheduled task. Returns true if a task was actually cancelled.
 */
export function cancelTaskInDb(taskId: string): boolean {
  const database = db.getDatabase();
  const result = database.prepare(`
    UPDATE deferred_tasks SET status = 'expired', updated_at = ?
    WHERE id = ? AND status = 'scheduled'
  `).run(new Date().toISOString(), taskId);

  if (result.changes > 0) {
    log.info("Task cancelled", { taskId });
    return true;
  }
  return false;
}

/**
 * Mark a task as executing and increment attempt count.
 */
export function markExecuting(taskId: string): void {
  const database = db.getDatabase();
  database.prepare(`
    UPDATE deferred_tasks SET status = 'executing', attempt_count = attempt_count + 1, updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), taskId);
}

/**
 * Mark a task as completed with a result.
 */
export function markCompleted(taskId: string, result: string): void {
  const database = db.getDatabase();
  database.prepare(`
    UPDATE deferred_tasks SET status = 'completed', result = ?, updated_at = ?
    WHERE id = ?
  `).run(result, new Date().toISOString(), taskId);
}

/**
 * Mark a task as permanently failed.
 */
export function markFailed(taskId: string, error: string): void {
  const database = db.getDatabase();
  database.prepare(`
    UPDATE deferred_tasks SET status = 'failed', error = ?, updated_at = ?
    WHERE id = ?
  `).run(error, new Date().toISOString(), taskId);
}

/**
 * Reschedule a task for retry with a new scheduled_for time.
 */
export function rescheduleForRetry(taskId: string, retryAt: Date, error: string): void {
  const database = db.getDatabase();
  database.prepare(`
    UPDATE deferred_tasks SET status = 'scheduled', scheduled_for = ?, error = ?, updated_at = ?
    WHERE id = ?
  `).run(retryAt.toISOString(), error, new Date().toISOString(), taskId);
}

/**
 * Mark a task as expired.
 */
export function markExpired(taskId: string): void {
  const database = db.getDatabase();
  database.prepare(`
    UPDATE deferred_tasks SET status = 'expired', updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), taskId);
}
