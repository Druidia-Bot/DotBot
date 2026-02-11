/**
 * Tool Handlers — Scheduled Tasks
 * 
 * Local-only recurring task management. Reads/writes ~/.bot/scheduled-tasks.json.
 * No server involvement — all state lives on the user's machine.
 * 
 * Due tasks are detected by the periodic scheduled task checker (checker.ts)
 * and submitted to the server pipeline for execution.
 */

import type { ToolExecResult } from "./tool-executor.js";
import {
  createScheduledTask,
  listScheduledTasks,
  cancelScheduledTask,
  pauseScheduledTask,
  resumeScheduledTask,
} from "../scheduled-tasks/store.js";
import type { TaskSchedule, ScheduleType } from "../scheduled-tasks/store.js";

const VALID_TYPES: ScheduleType[] = ["daily", "weekly", "hourly", "interval"];

export async function handleSchedule(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {

    // ----------------------------------------
    // schedule.create
    // ----------------------------------------
    case "schedule.create": {
      const name = args.name;
      const prompt = args.prompt;
      const type = args.type as ScheduleType;

      if (!name) return { success: false, output: "", error: "name is required." };
      if (!prompt) return { success: false, output: "", error: "prompt is required." };
      if (!type || !VALID_TYPES.includes(type)) {
        return { success: false, output: "", error: `type must be one of: ${VALID_TYPES.join(", ")}` };
      }

      // Validate type-specific params
      if (type === "daily" || type === "weekly") {
        const time = args.time;
        if (!time || !/^\d{1,2}:\d{2}$/.test(time)) {
          return { success: false, output: "", error: `time is required for ${type} schedules (format: "HH:MM", e.g. "06:00").` };
        }
        const [h, m] = time.split(":").map(Number);
        if (h < 0 || h > 23 || m < 0 || m > 59) {
          return { success: false, output: "", error: `Invalid time "${time}". Hours must be 0-23, minutes 0-59.` };
        }
      }
      if (type === "weekly") {
        const day = args.day_of_week;
        if (day === undefined || day === null || day < 0 || day > 6) {
          return { success: false, output: "", error: "day_of_week is required for weekly schedules (0=Sunday, 1=Monday, ..., 6=Saturday)." };
        }
      }
      if (type === "interval") {
        const minutes = args.interval_minutes;
        if (!minutes || minutes < 5) {
          return { success: false, output: "", error: "interval_minutes is required for interval schedules (minimum 5 minutes)." };
        }
      }

      const schedule: TaskSchedule = {
        type,
        time: args.time,
        dayOfWeek: args.day_of_week,
        intervalMinutes: args.interval_minutes,
      };

      try {
        const task = await createScheduledTask({
          name,
          prompt,
          schedule,
          personaHint: args.persona_hint,
          priority: args.priority || "P2",
        });

        return {
          success: true,
          output: JSON.stringify({
            created: true,
            id: task.id,
            name: task.name,
            schedule: describeSchedule(task.schedule),
            next_run: task.nextRunAt,
            stored_at: "~/.bot/scheduled-tasks.json",
            note: "Task will be checked every 60 seconds and submitted to the server pipeline when due.",
          }, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    }

    // ----------------------------------------
    // schedule.list
    // ----------------------------------------
    case "schedule.list": {
      const statusFilter = args.status || "active";

      try {
        const tasks = await listScheduledTasks(statusFilter === "all" ? undefined : statusFilter);

        if (tasks.length === 0) {
          return {
            success: true,
            output: JSON.stringify({
              tasks: [],
              total: 0,
              message: statusFilter === "active"
                ? "No active scheduled tasks."
                : `No tasks with status "${statusFilter}".`,
            }, null, 2),
          };
        }

        return {
          success: true,
          output: JSON.stringify({
            tasks: tasks.map(t => ({
              id: t.id,
              name: t.name,
              schedule: describeSchedule(t.schedule),
              next_run: t.nextRunAt,
              last_run: t.lastRunAt || "never",
              status: t.status,
              consecutive_failures: t.consecutiveFailures,
              priority: t.priority,
            })),
            total: tasks.length,
          }, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    }

    // ----------------------------------------
    // schedule.cancel
    // ----------------------------------------
    case "schedule.cancel": {
      const taskId = args.task_id;
      if (!taskId) return { success: false, output: "", error: "task_id is required." };

      try {
        const cancelled = await cancelScheduledTask(taskId);
        if (!cancelled) {
          return { success: false, output: "", error: `Task "${taskId}" not found or already cancelled.` };
        }
        return {
          success: true,
          output: JSON.stringify({ cancelled: true, id: taskId }, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    }

    // ----------------------------------------
    // schedule.pause
    // ----------------------------------------
    case "schedule.pause": {
      const taskId = args.task_id;
      if (!taskId) return { success: false, output: "", error: "task_id is required." };

      try {
        const paused = await pauseScheduledTask(taskId);
        if (!paused) {
          return { success: false, output: "", error: `Task "${taskId}" not found or not active.` };
        }
        return {
          success: true,
          output: JSON.stringify({ paused: true, id: taskId }, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    }

    // ----------------------------------------
    // schedule.resume
    // ----------------------------------------
    case "schedule.resume": {
      const taskId = args.task_id;
      if (!taskId) return { success: false, output: "", error: "task_id is required." };

      try {
        const resumed = await resumeScheduledTask(taskId);
        if (!resumed) {
          return { success: false, output: "", error: `Task "${taskId}" not found or not paused.` };
        }
        return {
          success: true,
          output: JSON.stringify({ resumed: true, id: taskId }, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    }

    default:
      return { success: false, output: "", error: `Unknown schedule tool: ${toolId}` };
  }
}

// ============================================
// HELPERS
// ============================================

function describeSchedule(s: TaskSchedule): string {
  switch (s.type) {
    case "daily":
      return `Daily at ${s.time || "09:00"}`;
    case "weekly": {
      const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      return `Weekly on ${days[s.dayOfWeek ?? 1]} at ${s.time || "09:00"}`;
    }
    case "hourly":
      return "Every hour";
    case "interval":
      return `Every ${s.intervalMinutes ?? 60} minutes`;
    default:
      return s.type;
  }
}
