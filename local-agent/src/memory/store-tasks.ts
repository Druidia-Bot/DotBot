/**
 * Task Store
 * 
 * Persistent task tracking stored at ~/.bot/tasks.json.
 * Tasks survive disconnections, server restarts, and bad tool calls.
 * The future "pulse" feature will check this file to resume stalled work.
 */

import { promises as fs } from "fs";
import path from "path";
import { nanoid } from "nanoid";
import { DOTBOT_DIR } from "./store-core.js";
import type { Task, TaskLog, TaskStatus, TaskStep } from "./types.js";

const TASKS_PATH = path.join(DOTBOT_DIR, "tasks.json");

// ============================================
// READ / WRITE
// ============================================

async function readTaskLog(): Promise<TaskLog> {
  try {
    const raw = await fs.readFile(TASKS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { version: "1.0", lastUpdatedAt: new Date().toISOString(), tasks: [] };
  }
}

async function writeTaskLog(log: TaskLog): Promise<void> {
  log.lastUpdatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(TASKS_PATH), { recursive: true });
  await fs.writeFile(TASKS_PATH, JSON.stringify(log, null, 2), "utf-8");
}

// ============================================
// CRUD OPERATIONS
// ============================================

/**
 * Create a new task. Returns the created task.
 */
export async function createTask(data: {
  description: string;
  priority?: "low" | "medium" | "high";
  threadId?: string;
  personaId?: string;
  originPrompt: string;
  steps?: Omit<TaskStep, "id" | "status">[];
}): Promise<Task> {
  const log = await readTaskLog();
  const now = new Date().toISOString();

  const task: Task = {
    id: `task_${nanoid(12)}`,
    description: data.description,
    status: "in_progress",
    priority: data.priority || "medium",
    createdAt: now,
    updatedAt: now,
    threadId: data.threadId,
    personaId: data.personaId,
    originPrompt: data.originPrompt,
    steps: (data.steps || []).map((s, i) => ({
      id: `step_${nanoid(8)}`,
      description: s.description,
      status: i === 0 ? "in_progress" : "pending",
      personaId: s.personaId,
      startedAt: i === 0 ? now : undefined,
    })),
    retryCount: 0,
  };

  log.tasks.push(task);
  await writeTaskLog(log);
  console.log(`[Tasks] Created: ${task.id} — ${task.description.substring(0, 60)}`);
  return task;
}

/**
 * Update a task by ID. Merges the provided fields.
 */
export async function updateTask(
  taskId: string,
  updates: Partial<Pick<Task, "status" | "priority" | "description" | "threadId" |
    "personaId" | "blockedReason" | "lastError" | "lastResponse" | "retryCount" | "completedAt">>
): Promise<Task | null> {
  const log = await readTaskLog();
  const task = log.tasks.find(t => t.id === taskId);
  if (!task) return null;

  Object.assign(task, updates, { updatedAt: new Date().toISOString() });

  if (updates.status === "completed" && !task.completedAt) {
    task.completedAt = new Date().toISOString();
  }

  await writeTaskLog(log);
  console.log(`[Tasks] Updated: ${taskId} → ${task.status}`);
  return task;
}

/**
 * Update a specific step within a task.
 */
export async function updateTaskStep(
  taskId: string,
  stepId: string,
  updates: Partial<Pick<TaskStep, "status" | "error" | "completedAt">>
): Promise<Task | null> {
  const log = await readTaskLog();
  const task = log.tasks.find(t => t.id === taskId);
  if (!task) return null;

  const step = task.steps.find(s => s.id === stepId);
  if (!step) return null;

  Object.assign(step, updates);
  if (updates.status === "in_progress" && !step.startedAt) {
    step.startedAt = new Date().toISOString();
  }
  if (updates.status === "completed" && !step.completedAt) {
    step.completedAt = new Date().toISOString();
  }

  task.updatedAt = new Date().toISOString();
  await writeTaskLog(log);
  return task;
}

/**
 * Get a single task by ID.
 */
export async function getTask(taskId: string): Promise<Task | null> {
  const log = await readTaskLog();
  return log.tasks.find(t => t.id === taskId) || null;
}

/**
 * Get all tasks, optionally filtered by status.
 */
export async function getTasks(filter?: {
  status?: TaskStatus | TaskStatus[];
  limit?: number;
}): Promise<Task[]> {
  const log = await readTaskLog();
  let tasks = log.tasks;

  if (filter?.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    tasks = tasks.filter(t => statuses.includes(t.status));
  }

  // Most recent first
  tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  if (filter?.limit) {
    tasks = tasks.slice(0, filter.limit);
  }

  return tasks;
}

/**
 * Get tasks that are resumable (blocked or failed, not exceeded retry limit).
 */
export async function getResumableTasks(maxRetries = 3): Promise<Task[]> {
  const log = await readTaskLog();
  return log.tasks.filter(t =>
    (t.status === "blocked" || t.status === "failed") &&
    t.retryCount < maxRetries
  ).sort((a, b) => {
    // High priority first, then most recent
    const pOrder = { high: 0, medium: 1, low: 2 };
    const pDiff = pOrder[a.priority] - pOrder[b.priority];
    if (pDiff !== 0) return pDiff;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

/**
 * Clean up old completed tasks (keep last N).
 */
export async function pruneCompletedTasks(keepCount = 50): Promise<number> {
  const log = await readTaskLog();
  const completed = log.tasks
    .filter(t => t.status === "completed")
    .sort((a, b) => (b.completedAt || b.updatedAt).localeCompare(a.completedAt || a.updatedAt));

  if (completed.length <= keepCount) return 0;

  const toRemove = new Set(completed.slice(keepCount).map(t => t.id));
  const before = log.tasks.length;
  log.tasks = log.tasks.filter(t => !toRemove.has(t.id));
  await writeTaskLog(log);

  const removed = before - log.tasks.length;
  if (removed > 0) {
    console.log(`[Tasks] Pruned ${removed} old completed tasks`);
  }
  return removed;
}
