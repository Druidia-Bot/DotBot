/**
 * Recurring Scheduler — Server-Side Recurring Task Execution
 *
 * Manages user-defined recurring tasks (daily, weekly, hourly, interval).
 * Tasks persist in SQLite but REQUIRE a connected client to execute because:
 * - API credentials use split-knowledge architecture (encrypted blob on client, key on server)
 * - Tools like http.request, brave_search, etc. need credential blobs from the client
 * - Neither server nor client alone can access credential plaintext
 *
 * Flow:
 * 1. LLM creates task via schedule.create tool → stored in recurring_tasks table
 * 2. Poll loop checks for due tasks every 30s
 * 3. Verifies client is connected before executing (fails gracefully if not)
 * 4. Due tasks submitted as synthetic prompts through the agent pipeline
 * 5. Results stored and streamed to connected client
 * 6. next_run_at advanced to the next occurrence
 *
 * This is separate from the deferred task scheduler (service.ts) which handles
 * one-shot retries with exponential backoff.
 */

import { nanoid } from "nanoid";
import * as db from "../../db/index.js";
import { createComponentLogger } from "#logging.js";
import type {
  RecurringTask,
  CreateRecurringTaskParams,
  RecurringEvent,
  RecurringEventCallback,
  RecurringSchedulerConfig,
  TaskSchedule,
} from "./recurring-types.js";
import { DEFAULT_RECURRING_CONFIG } from "./recurring-types.js";

const log = createComponentLogger("recurring-scheduler");

// ============================================
// STATE
// ============================================

let config: RecurringSchedulerConfig = { ...DEFAULT_RECURRING_CONFIG };
let nextPollTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let polling = false;

/** Maximum delay for setTimeout (Node.js limit: ~24.8 days) */
const MAX_TIMEOUT_MS = 2_147_483_647;
const activeExecutions = new Set<string>();
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

  ensureSchema();

  log.info("Recurring scheduler started", {
    maxConcurrent: config.maxConcurrent,
  });

  // Run an immediate poll, then arm the timer wheel
  pollDueTasks().then(() => scheduleNextPoll());
}

/**
 * Stop the recurring scheduler gracefully.
 */
export async function stopRecurringScheduler(): Promise<void> {
  if (!running) return;

  running = false;
  if (nextPollTimer) {
    clearTimeout(nextPollTimer);
    nextPollTimer = null;
  }

  // Drain active executions (wait up to 30s)
  if (activeExecutions.size > 0) {
    log.info("Recurring scheduler draining", { count: activeExecutions.size });
    const drainStart = Date.now();
    while (activeExecutions.size > 0 && Date.now() - drainStart < 30_000) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (activeExecutions.size > 0) {
      log.warn("Drain timed out", { remaining: activeExecutions.size });
    }
  }

  log.info("Recurring scheduler stopped");
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
// SCHEMA
// ============================================

function ensureSchema(): void {
  try {
    const database = db.getDatabase();
    database.exec(`
      CREATE TABLE IF NOT EXISTS recurring_tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        device_id TEXT,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        persona_hint TEXT,
        schedule_type TEXT NOT NULL,
        schedule_time TEXT,
        schedule_day_of_week INTEGER,
        schedule_interval_minutes INTEGER,
        timezone TEXT DEFAULT 'UTC',
        priority TEXT DEFAULT 'P2',
        status TEXT DEFAULT 'active',
        last_run_at TEXT,
        next_run_at TEXT NOT NULL,
        last_result TEXT,
        last_error TEXT,
        consecutive_failures INTEGER DEFAULT 0,
        max_failures INTEGER DEFAULT 3,
        missed_prompt_sent_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_recurring_next_run
        ON recurring_tasks(next_run_at) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_recurring_user
        ON recurring_tasks(user_id);
      CREATE INDEX IF NOT EXISTS idx_recurring_status
        ON recurring_tasks(status);
    `);
  } catch (error) {
    log.error("Failed to ensure recurring schema", { error });
  }
}

// ============================================
// TASK CRUD
// ============================================

/**
 * Create a new recurring task.
 */
export function createRecurringTask(
  params: CreateRecurringTaskParams
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
    maxFailures: params.maxFailures ?? config.defaultMaxFailures,
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

  emitEvent({
    type: "recurring_created",
    taskId: task.id,
    userId: task.userId,
    taskName: task.name,
    timestamp: now,
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
 * Cancel a recurring task.
 */
export function cancelRecurringTask(
  taskId: string,
  userId: string
): boolean {
  const database = db.getDatabase();
  const result = database.prepare(`
    UPDATE recurring_tasks SET status = 'cancelled', updated_at = ?
    WHERE id = ? AND user_id = ? AND status != 'cancelled'
  `).run(new Date().toISOString(), taskId, userId);

  if (result.changes > 0) {
    log.info("Recurring task cancelled", { taskId });
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
    return true;
  }
  return false;
}

/**
 * Pause a recurring task.
 */
export function pauseRecurringTask(
  taskId: string,
  userId: string
): boolean {
  const database = db.getDatabase();
  const result = database.prepare(`
    UPDATE recurring_tasks SET status = 'paused', updated_at = ?
    WHERE id = ? AND user_id = ? AND status = 'active'
  `).run(new Date().toISOString(), taskId, userId);

  if (result.changes > 0) {
    log.info("Recurring task paused", { taskId });
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
    return true;
  }
  return false;
}

/**
 * Manually execute a missed task (user confirmed they want to run it).
 * This triggers execution immediately without waiting for the next scheduled time.
 */
export async function executeRecurringTaskNow(
  taskId: string,
  userId: string
): Promise<boolean> {
  const task = getRecurringTask(taskId);
  if (!task || task.userId !== userId) return false;

  // Clear the missed prompt flag
  const database = db.getDatabase();
  database.prepare(`
    UPDATE recurring_tasks
    SET missed_prompt_sent_at = NULL, updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), taskId);

  // Execute immediately (if not already running)
  if (!activeExecutions.has(task.id)) {
    // Reload task with cleared missedPromptSentAt
    const refreshedTask = getRecurringTask(taskId);
    if (refreshedTask) {
      executeRecurringTask(refreshedTask);
      return true;
    }
  }

  return false;
}

/**
 * Resume a paused recurring task. Resets failures and recalculates next run.
 */
export function resumeRecurringTask(
  taskId: string,
  userId: string
): boolean {
  const database = db.getDatabase();
  const task = getRecurringTask(taskId);
  if (!task || task.userId !== userId || task.status !== "paused") return false;

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

  emitEvent({
    type: "recurring_resumed",
    taskId,
    userId: task.userId,
    taskName: task.name,
    timestamp: new Date(),
    details: { nextRunAt: nextRun.toISOString() },
  });

  // Re-arm timer — resumed task has a new next_run_at
  scheduleNextPoll();

  return true;
}

/**
 * Get tasks that ran while a device was offline.
 * Returns tasks where last_run_at > deviceLastSeen.
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

// ============================================
// STATS
// ============================================

export interface RecurringStats {
  active: number;
  paused: number;
  cancelled: number;
  totalExecutions: number;
  activeExecutions: number;
}

export function getRecurringStats(): RecurringStats {
  const database = db.getDatabase();

  const counts = database.prepare(`
    SELECT status, COUNT(*) as count FROM recurring_tasks GROUP BY status
  `).all() as { status: string; count: number }[];

  const stats: RecurringStats = {
    active: 0,
    paused: 0,
    cancelled: 0,
    totalExecutions: 0,
    activeExecutions: activeExecutions.size,
  };

  for (const row of counts) {
    if (row.status === "active") stats.active = row.count;
    else if (row.status === "paused") stats.paused = row.count;
    else if (row.status === "cancelled") stats.cancelled = row.count;
  }

  // Total executions = sum of all tasks that have been run at least once
  const totalRow = database.prepare(`
    SELECT COUNT(*) as count FROM recurring_tasks WHERE last_run_at IS NOT NULL
  `).get() as { count: number };
  stats.totalExecutions = totalRow.count;

  return stats;
}

// ============================================
// TIMER WHEEL
// ============================================

/**
 * Query the earliest next_run_at across all active recurring tasks.
 * Returns null if no tasks are pending.
 */
function getNextDueTime(): Date | null {
  try {
    const database = db.getDatabase();
    const row = database.prepare(`
      SELECT MIN(next_run_at) as next_due
      FROM recurring_tasks
      WHERE status = 'active'
    `).get() as { next_due: string | null } | undefined;
    if (row?.next_due) return new Date(row.next_due);
  } catch (error) {
    log.error("Failed to query next due time", { error });
  }
  return null;
}

/**
 * Arm a single setTimeout for the next due recurring task.
 * Called after every mutation (create, cancel, pause, resume, execute)
 * and after each poll.
 */
function scheduleNextPoll(): void {
  if (!running) return;

  // Clear any existing timer
  if (nextPollTimer) {
    clearTimeout(nextPollTimer);
    nextPollTimer = null;
  }

  const nextDue = getNextDueTime();
  if (!nextDue) {
    log.debug("No active recurring tasks — timer idle");
    return;
  }

  const delayMs = Math.max(0, Math.min(nextDue.getTime() - Date.now(), MAX_TIMEOUT_MS));

  nextPollTimer = setTimeout(async () => {
    await pollDueTasks();
    scheduleNextPoll(); // Re-arm for the next batch
  }, delayMs);

  log.debug("Recurring poll armed", { delayMs, nextDue: nextDue.toISOString() });
}

// ============================================
// POLLING & EXECUTION
// ============================================

async function pollDueTasks(): Promise<void> {
  if (!running || polling) return;
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
          handleMissedTask(task);
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
      executeRecurringTask(task);
    }
  } catch (error) {
    log.error("Error polling recurring tasks", { error });
  } finally {
    polling = false;
  }
}

/**
 * Handle a missed task (overdue > 2 hours).
 * Emits a "recurring_missed" event asking the user if they want to run it,
 * then advances nextRunAt to prevent pileup.
 */
function handleMissedTask(task: RecurringTask): void {
  const database = db.getDatabase();
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

  // Mark that we've asked the user about this missed run
  database.prepare(`
    UPDATE recurring_tasks
    SET missed_prompt_sent_at = ?, next_run_at = ?, updated_at = ?
    WHERE id = ?
  `).run(now.toISOString(), nextRun.toISOString(), now.toISOString(), task.id);

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

async function executeRecurringTask(task: RecurringTask): Promise<void> {
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
  const database = db.getDatabase();

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
    const now = new Date().toISOString();

    database.prepare(`
      UPDATE recurring_tasks
      SET last_run_at = ?, last_result = ?, last_error = NULL,
          consecutive_failures = 0, missed_prompt_sent_at = NULL,
          next_run_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, result.substring(0, 5000), nextRun.toISOString(), now, task.id);

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
    const newFailures = task.consecutiveFailures + 1;

    // Advance next_run_at regardless of failure (don't pile up)
    const schedule: TaskSchedule = {
      type: task.scheduleType,
      time: task.scheduleTime || undefined,
      dayOfWeek: task.scheduleDayOfWeek ?? undefined,
      intervalMinutes: task.scheduleIntervalMinutes ?? undefined,
    };
    const nextRun = calculateNextRun(schedule, new Date(), task.timezone);
    const now = new Date().toISOString();

    if (newFailures >= task.maxFailures) {
      // Auto-pause
      database.prepare(`
        UPDATE recurring_tasks
        SET last_run_at = ?, last_error = ?, consecutive_failures = ?,
            status = 'paused', next_run_at = ?, updated_at = ?
        WHERE id = ?
      `).run(now, errorMsg, newFailures, nextRun.toISOString(), now, task.id);

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
      // Just record failure, advance to next run
      database.prepare(`
        UPDATE recurring_tasks
        SET last_run_at = ?, last_error = ?, consecutive_failures = ?,
            next_run_at = ?, updated_at = ?
        WHERE id = ?
      `).run(now, errorMsg, newFailures, nextRun.toISOString(), now, task.id);

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

// ============================================
// NEXT RUN CALCULATION
// ============================================

/**
 * Calculate the next run time for a schedule.
 * Mirrors the client-side logic in local-agent/src/scheduled-tasks/store.ts
 * but uses explicit timezone instead of system local time.
 *
 * @param schedule - The schedule definition
 * @param after - Calculate next run after this time
 * @param timezone - IANA timezone string (e.g., "America/New_York")
 */
export function calculateNextRun(
  schedule: TaskSchedule,
  after: Date,
  timezone: string = "UTC"
): Date {
  switch (schedule.type) {
    case "daily":
      return calculateNextDaily(schedule.time || "09:00", after, timezone);
    case "weekly":
      return calculateNextWeekly(
        schedule.time || "09:00",
        schedule.dayOfWeek ?? 1,
        after,
        timezone
      );
    case "hourly":
      return calculateNextHourly(after);
    case "interval":
      return calculateNextInterval(schedule.intervalMinutes || 60, after);
    default:
      // Fallback: 1 hour from now
      return new Date(after.getTime() + 3_600_000);
  }
}

function calculateNextDaily(
  time: string,
  after: Date,
  timezone: string
): Date {
  const [hours, minutes] = parseTime(time);

  // Create target in the specified timezone
  const target = dateInTimezone(after, timezone);
  target.setHours(hours, minutes, 0, 0);

  // If target is in the past or exactly now, advance to tomorrow
  if (target <= after) {
    target.setDate(target.getDate() + 1);
    target.setHours(hours, minutes, 0, 0);
  }

  return target;
}

function calculateNextWeekly(
  time: string,
  dayOfWeek: number,
  after: Date,
  timezone: string
): Date {
  const [hours, minutes] = parseTime(time);

  const target = dateInTimezone(after, timezone);
  target.setHours(hours, minutes, 0, 0);

  // Advance to the correct day of week
  const currentDay = target.getDay();
  let daysUntil = dayOfWeek - currentDay;
  if (daysUntil < 0) daysUntil += 7;
  if (daysUntil === 0 && target <= after) daysUntil = 7;

  target.setDate(target.getDate() + daysUntil);
  target.setHours(hours, minutes, 0, 0);

  return target;
}

function calculateNextHourly(after: Date): Date {
  const target = new Date(after);
  target.setMinutes(0, 0, 0);
  target.setHours(target.getHours() + 1);
  return target;
}

function calculateNextInterval(intervalMinutes: number, after: Date): Date {
  const ms = Math.max(intervalMinutes, 5) * 60_000;
  return new Date(after.getTime() + ms);
}

// ============================================
// HELPERS
// ============================================

function parseTime(time: string): [number, number] {
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return [9, 0]; // Default 9:00 AM
  const h = parseInt(match[1]);
  const m = parseInt(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return [9, 0];
  return [h, m];
}

/**
 * Create a Date object adjusted for a timezone.
 * Uses Intl.DateTimeFormat to get the offset, then adjusts.
 *
 * ⚠️ LIMITATION: This is a simplified timezone handler for basic use cases.
 * It may not handle DST transitions correctly or work reliably across all timezones.
 * For production use with complex timezone requirements, consider using:
 * - luxon (https://moment.github.io/luxon/)
 * - date-fns-tz (https://github.com/marnusw/date-fns-tz)
 *
 * Current implementation works for common timezones (America/New_York, Europe/London, etc.)
 * but may fail on DST boundaries or with historical dates.
 */
function dateInTimezone(date: Date, timezone: string): Date {
  try {
    // Get the timezone offset by formatting and parsing
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const get = (type: string) =>
      parseInt(parts.find(p => p.type === type)?.value || "0");

    // Reconstruct date in target timezone
    // NOTE: This creates a local Date object with the timezone's wall-clock time
    // DST transitions may cause unexpected behavior
    const tzDate = new Date(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second")
    );
    return tzDate;
  } catch (err) {
    // Invalid timezone — fall back to original date
    // In production, this should log the error for debugging
    return new Date(date);
  }
}

function emitEvent(event: RecurringEvent): void {
  for (const listener of eventListeners) {
    try {
      listener(event);
    } catch (error) {
      log.error("Recurring event listener error", { error });
    }
  }
}

function rowToTask(row: any): RecurringTask {
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
