/**
 * Server-Side Schedule Tool Handlers
 *
 * Handles schedule.* tool calls server-side (bypasses local agent).
 * These tools write directly to the recurring_tasks SQLite table.
 *
 * Tool IDs handled:
 * - schedule.create → createRecurringTask
 * - schedule.list → listRecurringTasks
 * - schedule.cancel → cancelRecurringTask
 * - schedule.pause → pauseRecurringTask
 * - schedule.resume → resumeRecurringTask
 */

import { createComponentLogger } from "#logging.js";
import {
  createRecurringTask,
  listRecurringTasks,
  getRecurringTask,
  cancelRecurringTask,
  pauseRecurringTask,
  resumeRecurringTask,
} from "../../services/scheduler/recurring.js";
import type { TaskSchedule } from "../../services/scheduler/recurring-types.js";

const log = createComponentLogger("schedule-tools");

export interface ScheduleToolResult {
  success: boolean;
  output: string;
  error?: string;
}

/**
 * Execute a schedule.* tool call server-side.
 */
export function executeScheduleTool(
  userId: string,
  toolId: string,
  args: Record<string, any>
): ScheduleToolResult {
  try {
    switch (toolId) {
      case "schedule.create":
        return handleCreate(userId, args);
      case "schedule.list":
        return handleList(userId, args);
      case "schedule.cancel":
        return handleCancel(userId, args);
      case "schedule.pause":
        return handlePause(userId, args);
      case "schedule.resume":
        return handleResume(userId, args);
      default:
        return { success: false, output: "", error: `Unknown schedule tool: ${toolId}` };
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error("Schedule tool error", { toolId, error: errMsg });
    return { success: false, output: "", error: errMsg };
  }
}

// ============================================
// HANDLERS
// ============================================

function handleCreate(userId: string, args: Record<string, any>): ScheduleToolResult {
  const { name, prompt, type, time, day_of_week, interval_minutes, persona_hint, timezone, priority } = args;

  if (!name || !prompt || !type) {
    return { success: false, output: "", error: "name, prompt, and type are required" };
  }

  // Validate schedule type
  const validTypes = ["daily", "weekly", "hourly", "interval"];
  if (!validTypes.includes(type)) {
    return { success: false, output: "", error: `Invalid schedule type: ${type}. Must be one of: ${validTypes.join(", ")}` };
  }

  // Validate time format for daily/weekly
  if ((type === "daily" || type === "weekly") && time) {
    if (!/^\d{1,2}:\d{2}$/.test(time)) {
      return { success: false, output: "", error: `Invalid time format: ${time}. Use HH:MM (e.g., 06:00, 14:30)` };
    }
    const [h, m] = time.split(":").map(Number);
    if (h < 0 || h > 23 || m < 0 || m > 59) {
      return { success: false, output: "", error: `Invalid time: hours must be 0-23, minutes 0-59` };
    }
  }

  // Validate day of week for weekly
  if (type === "weekly") {
    const dow = day_of_week ?? 1;
    if (dow < 0 || dow > 6) {
      return { success: false, output: "", error: "day_of_week must be 0-6 (0=Sunday, 6=Saturday)" };
    }
  }

  // Validate interval
  if (type === "interval") {
    const interval = interval_minutes ?? 60;
    if (interval < 5) {
      return { success: false, output: "", error: "interval_minutes must be at least 5" };
    }
  }

  const schedule: TaskSchedule = {
    type: type as TaskSchedule["type"],
    time: time || undefined,
    dayOfWeek: day_of_week ?? undefined,
    intervalMinutes: interval_minutes ?? undefined,
  };

  const task = createRecurringTask({
    userId,
    name,
    prompt,
    personaHint: persona_hint,
    schedule,
    timezone: timezone || undefined,
    priority: priority || undefined,
  });

  log.info("Schedule tool: created recurring task", { id: task.id, name: task.name });

  return {
    success: true,
    output: `Created scheduled task "${task.name}" (${task.id}).\n` +
      `Schedule: ${formatSchedule(schedule)}\n` +
      `Next run: ${task.nextRunAt.toISOString()}\n` +
      `Timezone: ${task.timezone}`,
  };
}

function handleList(userId: string, args: Record<string, any>): ScheduleToolResult {
  const { status } = args;
  const tasks = listRecurringTasks(userId, status);

  if (tasks.length === 0) {
    return { success: true, output: "No scheduled tasks found." };
  }

  const lines = tasks.map(t => {
    const scheduleDesc = formatSchedule({
      type: t.scheduleType,
      time: t.scheduleTime || undefined,
      dayOfWeek: t.scheduleDayOfWeek ?? undefined,
      intervalMinutes: t.scheduleIntervalMinutes ?? undefined,
    });
    const statusInfo = t.status === "paused"
      ? ` [PAUSED — ${t.consecutiveFailures} failures]`
      : t.status === "cancelled"
        ? " [CANCELLED]"
        : "";
    const lastRun = t.lastRunAt ? ` | Last run: ${t.lastRunAt.toISOString()}` : "";
    return `- **${t.name}** (${t.id}): ${scheduleDesc}${statusInfo}\n  Next: ${t.nextRunAt.toISOString()}${lastRun}`;
  });

  return {
    success: true,
    output: `${tasks.length} scheduled task(s):\n\n${lines.join("\n\n")}`,
  };
}

function handleCancel(userId: string, args: Record<string, any>): ScheduleToolResult {
  const { id } = args;
  if (!id) return { success: false, output: "", error: "id is required" };

  const cancelled = cancelRecurringTask(id, userId);
  if (!cancelled) {
    return { success: false, output: "", error: `Task ${id} not found or already cancelled` };
  }
  return { success: true, output: `Cancelled scheduled task ${id}.` };
}

function handlePause(userId: string, args: Record<string, any>): ScheduleToolResult {
  const { id } = args;
  if (!id) return { success: false, output: "", error: "id is required" };

  const paused = pauseRecurringTask(id, userId);
  if (!paused) {
    return { success: false, output: "", error: `Task ${id} not found or not active` };
  }
  return { success: true, output: `Paused scheduled task ${id}. Use schedule.resume to reactivate.` };
}

function handleResume(userId: string, args: Record<string, any>): ScheduleToolResult {
  const { id } = args;
  if (!id) return { success: false, output: "", error: "id is required" };

  const resumed = resumeRecurringTask(id, userId);
  if (!resumed) {
    return { success: false, output: "", error: `Task ${id} not found or not paused` };
  }

  const task = getRecurringTask(id);
  return {
    success: true,
    output: `Resumed scheduled task ${id}.${task ? ` Next run: ${task.nextRunAt.toISOString()}` : ""}`,
  };
}

// ============================================
// HELPERS
// ============================================

function formatSchedule(schedule: TaskSchedule): string {
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  switch (schedule.type) {
    case "daily":
      return `Daily at ${schedule.time || "09:00"}`;
    case "weekly":
      return `Weekly on ${dayNames[schedule.dayOfWeek ?? 1]} at ${schedule.time || "09:00"}`;
    case "hourly":
      return "Every hour";
    case "interval":
      return `Every ${schedule.intervalMinutes || 60} minutes`;
    default:
      return schedule.type;
  }
}
