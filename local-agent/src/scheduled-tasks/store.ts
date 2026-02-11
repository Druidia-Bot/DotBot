/**
 * Scheduled Tasks Store
 * 
 * Persists recurring scheduled tasks as JSON in ~/.bot/scheduled-tasks.json.
 * No server involvement — CRUD is direct file I/O.
 * 
 * The periodic manager checks for due tasks every 60 seconds and submits
 * their prompts to the server pipeline for execution.
 */

import { promises as fs } from "fs";
import path from "path";
import { homedir } from "os";
import { nanoid } from "nanoid";

// ============================================
// TYPES
// ============================================

export type ScheduleType = "daily" | "weekly" | "hourly" | "interval";

export interface TaskSchedule {
  type: ScheduleType;
  time?: string;             // "06:00" (local time, for daily/weekly)
  dayOfWeek?: number;        // 0=Sun..6=Sat (for weekly)
  intervalMinutes?: number;  // for interval type
}

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  schedule: TaskSchedule;
  personaHint?: string;
  priority: "P0" | "P1" | "P2" | "P3";
  status: "active" | "paused" | "cancelled";
  lastRunAt?: string;
  nextRunAt: string;
  lastResult?: string;
  lastError?: string;
  consecutiveFailures: number;
  maxFailures: number;
  createdAt: string;
}

// ============================================
// CONSTANTS
// ============================================

const TASKS_PATH = path.join(homedir(), ".bot", "scheduled-tasks.json");
const GRACE_PERIOD_MS = 2 * 60 * 60 * 1000; // 2 hours
const DEFAULT_MAX_FAILURES = 3;
const MAX_CANCELLED_AGE_MS = 7 * 24 * 60 * 60 * 1000; // Prune cancelled tasks older than 7 days

// ============================================
// FILE I/O
// ============================================

async function readTasks(): Promise<ScheduledTask[]> {
  try {
    const data = await fs.readFile(TASKS_PATH, "utf-8");
    return JSON.parse(data);
  } catch (err: any) {
    // ENOENT = file doesn't exist yet (normal on first run). Anything else
    // (corrupt JSON, permission error) deserves a warning so we don't
    // silently lose all tasks.
    if (err?.code !== "ENOENT") {
      console.warn(`[Scheduled] Failed to read ${TASKS_PATH}:`, err?.message || err);
    }
    return [];
  }
}

async function writeTasks(tasks: ScheduledTask[]): Promise<void> {
  // Prune cancelled tasks older than 7 days to keep file size reasonable
  const cutoff = Date.now() - MAX_CANCELLED_AGE_MS;
  const pruned = tasks.filter(t => {
    if (t.status !== "cancelled") return true;
    return new Date(t.createdAt).getTime() > cutoff;
  });
  await fs.mkdir(path.dirname(TASKS_PATH), { recursive: true });
  await fs.writeFile(TASKS_PATH, JSON.stringify(pruned, null, 2), "utf-8");
}

// ============================================
// CRUD
// ============================================

export async function createScheduledTask(params: {
  name: string;
  prompt: string;
  schedule: TaskSchedule;
  personaHint?: string;
  priority?: string;
}): Promise<ScheduledTask> {
  const tasks = await readTasks();
  const now = new Date();

  const task: ScheduledTask = {
    id: `sched_${nanoid(12)}`,
    name: params.name,
    prompt: params.prompt,
    schedule: params.schedule,
    personaHint: params.personaHint,
    priority: (params.priority as ScheduledTask["priority"]) || "P2",
    status: "active",
    nextRunAt: calculateNextRun(params.schedule, now).toISOString(),
    consecutiveFailures: 0,
    maxFailures: DEFAULT_MAX_FAILURES,
    createdAt: now.toISOString(),
  };

  tasks.push(task);
  await writeTasks(tasks);
  return task;
}

export async function listScheduledTasks(statusFilter?: string): Promise<ScheduledTask[]> {
  const tasks = await readTasks();
  if (!statusFilter || statusFilter === "all") return tasks;
  return tasks.filter(t => t.status === statusFilter);
}

export async function getScheduledTask(id: string): Promise<ScheduledTask | null> {
  const tasks = await readTasks();
  return tasks.find(t => t.id === id) || null;
}

export async function cancelScheduledTask(id: string): Promise<boolean> {
  const tasks = await readTasks();
  const task = tasks.find(t => t.id === id && t.status !== "cancelled");
  if (!task) return false;
  task.status = "cancelled";
  await writeTasks(tasks);
  return true;
}

export async function pauseScheduledTask(id: string): Promise<boolean> {
  const tasks = await readTasks();
  const task = tasks.find(t => t.id === id && t.status === "active");
  if (!task) return false;
  task.status = "paused";
  await writeTasks(tasks);
  return true;
}

export async function resumeScheduledTask(id: string): Promise<boolean> {
  const tasks = await readTasks();
  const task = tasks.find(t => t.id === id && t.status === "paused");
  if (!task) return false;
  task.status = "active";
  task.nextRunAt = calculateNextRun(task.schedule, new Date()).toISOString();
  task.consecutiveFailures = 0;
  await writeTasks(tasks);
  return true;
}

// ============================================
// DUE / MISSED TASK DETECTION
// ============================================

export interface DueTask {
  task: ScheduledTask;
  type: "due" | "missed";
}

/**
 * Get tasks that are due for execution or missed beyond grace period.
 * - "due": nextRunAt <= now AND within grace period → execute
 * - "missed": nextRunAt <= now AND beyond grace period → ask user
 */
export async function getDueAndMissedTasks(): Promise<DueTask[]> {
  const tasks = await readTasks();
  const now = Date.now();
  const results: DueTask[] = [];

  for (const task of tasks) {
    if (task.status !== "active") continue;
    const nextRun = new Date(task.nextRunAt).getTime();
    if (nextRun > now) continue;

    const overdueMs = now - nextRun;
    if (overdueMs <= GRACE_PERIOD_MS) {
      results.push({ task, type: "due" });
    } else {
      results.push({ task, type: "missed" });
    }
  }

  return results;
}

// ============================================
// AFTER-RUN UPDATES
// ============================================

/**
 * Record a successful run and advance nextRunAt.
 */
export async function markTaskRun(id: string, result: string): Promise<void> {
  const tasks = await readTasks();
  const task = tasks.find(t => t.id === id);
  if (!task) return;

  const now = new Date();
  task.lastRunAt = now.toISOString();
  task.lastResult = result.substring(0, 2000);
  task.lastError = undefined;
  task.consecutiveFailures = 0;
  task.nextRunAt = calculateNextRun(task.schedule, now).toISOString();

  await writeTasks(tasks);
}

/**
 * Record a failed run. Pauses the task if maxFailures reached.
 */
export async function markTaskFailed(id: string, error: string): Promise<boolean> {
  const tasks = await readTasks();
  const task = tasks.find(t => t.id === id);
  if (!task) return false;

  const now = new Date();
  task.lastRunAt = now.toISOString();
  task.lastError = error;
  task.consecutiveFailures++;
  task.nextRunAt = calculateNextRun(task.schedule, now).toISOString();

  const paused = task.consecutiveFailures >= task.maxFailures;
  if (paused) {
    task.status = "paused";
  }

  await writeTasks(tasks);
  return paused;
}

/**
 * Advance a missed task to the next run without executing.
 */
export async function advanceMissedTask(id: string): Promise<void> {
  const tasks = await readTasks();
  const task = tasks.find(t => t.id === id);
  if (!task) return;

  task.nextRunAt = calculateNextRun(task.schedule, new Date()).toISOString();
  await writeTasks(tasks);
}

// ============================================
// NEXT-RUN CALCULATION
// ============================================

/**
 * Calculate the next run time AFTER the given reference date.
 */
export function calculateNextRun(schedule: TaskSchedule, after: Date): Date {
  switch (schedule.type) {
    case "interval": {
      const minutes = schedule.intervalMinutes || 60;
      return new Date(after.getTime() + minutes * 60_000);
    }

    case "hourly": {
      const next = new Date(after);
      next.setMinutes(0, 0, 0);
      next.setHours(next.getHours() + 1);
      return next;
    }

    case "daily": {
      const [hours, minutes] = parseTime(schedule.time || "09:00");
      const next = new Date(after);
      next.setHours(hours, minutes, 0, 0);
      // If that time already passed today, schedule for tomorrow
      if (next <= after) {
        next.setDate(next.getDate() + 1);
      }
      return next;
    }

    case "weekly": {
      const [hours, minutes] = parseTime(schedule.time || "09:00");
      const targetDay = schedule.dayOfWeek ?? 1; // default Monday
      const next = new Date(after);
      next.setHours(hours, minutes, 0, 0);

      // Advance to the target day of week
      const currentDay = next.getDay();
      let daysUntil = targetDay - currentDay;
      if (daysUntil < 0) daysUntil += 7;
      if (daysUntil === 0 && next <= after) daysUntil = 7;
      next.setDate(next.getDate() + daysUntil);

      return next;
    }

    default:
      // Fallback: 1 hour from now
      return new Date(after.getTime() + 3_600_000);
  }
}

// ============================================
// HELPERS
// ============================================

function parseTime(time: string): [number, number] {
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return [9, 0];
  return [parseInt(match[1], 10), parseInt(match[2], 10)];
}
