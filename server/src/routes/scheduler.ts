/**
 * Scheduler Routes
 *
 * Deferred task CRUD and recurring task CRUD.
 */

import type { Hono } from "hono";
import {
  getUserTasks,
  cancelTask,
  getStats as getSchedulerStats,
  listRecurringTasks,
  getRecurringTask,
  createRecurringTask,
  cancelRecurringTask,
  pauseRecurringTask,
  resumeRecurringTask,
  getRecurringStats,
} from "../scheduler/index.js";

// ============================================
// DEFERRED TASKS
// ============================================

export function registerSchedulerRoutes(app: Hono): void {
  // Get scheduler stats
  app.get("/api/scheduler/stats", (c) => {
    return c.json(getSchedulerStats());
  });

  // Get deferred tasks for a user
  app.get("/api/scheduler/tasks/:userId", (c) => {
    const userId = c.req.param("userId");
    const status = c.req.query("status") || undefined;
    const tasks = getUserTasks(userId, status);
    return c.json({ userId, tasks, count: tasks.length });
  });

  // Cancel a deferred task
  app.delete("/api/scheduler/tasks/:taskId", (c) => {
    const taskId = c.req.param("taskId");
    const cancelled = cancelTask(taskId);
    return c.json({ taskId, cancelled });
  });

  // ============================================
  // RECURRING TASKS
  // ============================================

  // Get recurring scheduler stats
  app.get("/api/recurring/stats", (c) => {
    return c.json(getRecurringStats());
  });

  // List recurring tasks for a user
  app.get("/api/recurring/tasks/:userId", (c) => {
    const userId = c.req.param("userId");
    const status = c.req.query("status") || undefined;
    const tasks = listRecurringTasks(userId, status);
    return c.json({ userId, tasks, count: tasks.length });
  });

  // Get a single recurring task
  app.get("/api/recurring/task/:taskId", (c) => {
    const taskId = c.req.param("taskId");
    const task = getRecurringTask(taskId);
    if (!task) return c.json({ error: "Task not found" }, 404);
    return c.json(task);
  });

  // Create a recurring task
  app.post("/api/recurring/tasks", async (c) => {
    const body = await c.req.json();
    const { userId, name, prompt, schedule, personaHint, timezone, priority, maxFailures, deviceId } = body;

    if (!userId || !name || !prompt || !schedule?.type) {
      return c.json({ error: "userId, name, prompt, and schedule.type are required" }, 400);
    }

    const task = createRecurringTask({
      userId,
      deviceId,
      name,
      prompt,
      personaHint,
      schedule,
      timezone,
      priority,
      maxFailures,
    });
    return c.json(task, 201);
  });

  // Cancel a recurring task
  app.delete("/api/recurring/tasks/:taskId", async (c) => {
    const taskId = c.req.param("taskId");
    const { userId } = await c.req.json().catch(() => ({ userId: "" }));
    if (!userId) return c.json({ error: "userId is required in body" }, 400);
    const cancelled = cancelRecurringTask(taskId, userId);
    return c.json({ taskId, cancelled });
  });

  // Pause a recurring task
  app.post("/api/recurring/tasks/:taskId/pause", async (c) => {
    const taskId = c.req.param("taskId");
    const { userId } = await c.req.json().catch(() => ({ userId: "" }));
    if (!userId) return c.json({ error: "userId is required in body" }, 400);
    const paused = pauseRecurringTask(taskId, userId);
    return c.json({ taskId, paused });
  });

  // Resume a recurring task
  app.post("/api/recurring/tasks/:taskId/resume", async (c) => {
    const taskId = c.req.param("taskId");
    const { userId } = await c.req.json().catch(() => ({ userId: "" }));
    if (!userId) return c.json({ error: "userId is required in body" }, 400);
    const resumed = resumeRecurringTask(taskId, userId);
    return c.json({ taskId, resumed });
  });
}
