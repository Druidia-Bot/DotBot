/**
 * Tool Handlers — Reminders
 * 
 * Local-only reminder management. Reads/writes ~/.bot/reminders.json directly.
 * No server involvement — all state lives on the user's machine.
 * 
 * Due reminders are detected by the periodic reminder checker (checker.ts)
 * and surfaced via console + Discord notifications.
 */

import type { ToolExecResult } from "./tool-executor.js";
import {
  createReminder,
  listReminders as listStore,
  cancelReminder as cancelStore,
} from "../reminders/store.js";

export async function handleReminder(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {

    // ----------------------------------------
    // reminder.set
    // ----------------------------------------
    case "reminder.set": {
      const message = args.message;
      const scheduledFor = args.scheduled_for;
      const priority = args.priority;

      if (!message) return { success: false, output: "", error: "message is required." };
      if (!scheduledFor) return { success: false, output: "", error: "scheduled_for is required." };

      const date = new Date(scheduledFor);
      if (isNaN(date.getTime())) {
        return { success: false, output: "", error: `Invalid date format: "${scheduledFor}". Use ISO 8601 (e.g., 2026-02-10T15:00:00-05:00).` };
      }

      if (date.getTime() < Date.now() - 60_000) {
        return { success: false, output: "", error: `Cannot set a reminder in the past. "${scheduledFor}" has already passed.` };
      }

      try {
        const reminder = await createReminder({
          message,
          scheduledFor: date.toISOString(),
          priority: priority || "P1",
        });

        return {
          success: true,
          output: JSON.stringify({
            created: true,
            id: reminder.id,
            message: reminder.message,
            scheduled_for: reminder.scheduledFor,
            priority: reminder.priority,
            stored_at: "~/.bot/reminders.json",
            note: "Reminders are checked every 15 seconds when idle. You'll be notified via console and Discord when it's due.",
          }, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    }

    // ----------------------------------------
    // reminder.list
    // ----------------------------------------
    case "reminder.list": {
      const statusFilter = args.status || "scheduled";

      try {
        const reminders = await listStore(statusFilter === "all" ? undefined : statusFilter);

        if (reminders.length === 0) {
          return {
            success: true,
            output: JSON.stringify({
              reminders: [],
              total: 0,
              message: statusFilter === "scheduled"
                ? "No pending reminders."
                : `No reminders with status "${statusFilter}".`,
            }, null, 2),
          };
        }

        return {
          success: true,
          output: JSON.stringify({
            reminders: reminders.map(r => ({
              id: r.id,
              message: r.message,
              scheduled_for: r.scheduledFor,
              priority: r.priority,
              status: r.status,
              created_at: r.createdAt,
            })),
            total: reminders.length,
          }, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    }

    // ----------------------------------------
    // reminder.cancel
    // ----------------------------------------
    case "reminder.cancel": {
      const taskId = args.task_id;
      if (!taskId) return { success: false, output: "", error: "task_id is required." };

      try {
        const cancelled = await cancelStore(taskId);

        if (!cancelled) {
          return { success: false, output: "", error: `Reminder "${taskId}" not found or already triggered/cancelled.` };
        }

        return {
          success: true,
          output: JSON.stringify({
            cancelled: true,
            id: taskId,
          }, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    }

    default:
      return { success: false, output: "", error: `Unknown reminder tool: ${toolId}` };
  }
}
