/**
 * Reminder / Scheduler Tool Definitions
 */

import type { DotBotTool } from "../../memory/types.js";

export const reminderTools: DotBotTool[] = [
  {
    id: "reminder.set",
    name: "set_reminder",
    description: "Set a reminder for a specific date/time. The reminder will be checked by the heartbeat system (every 5 minutes) and the user will be notified when it's due — including via Discord if configured. Use ISO 8601 format for the time, or natural language that you convert to ISO 8601.",
    source: "core",
    category: "reminder",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The reminder message — what should the user be reminded about" },
        scheduled_for: { type: "string", description: "When to trigger the reminder (ISO 8601 datetime, e.g. '2026-02-10T15:00:00-05:00')" },
        priority: { type: "string", description: "Priority level: P0 (urgent), P1 (important, default), P2 (normal), P3 (low)" },
      },
      required: ["message", "scheduled_for"],
    },
    annotations: { destructiveHint: true, mutatingHint: true },
  },
  {
    id: "reminder.list",
    name: "list_reminders",
    description: "List all scheduled reminders for the current user. Can filter by status (scheduled, completed, failed, expired).",
    source: "core",
    category: "reminder",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter by status: 'scheduled' (default, pending reminders), 'completed', 'failed', 'expired', or omit for all" },
      },
    },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
  {
    id: "reminder.cancel",
    name: "cancel_reminder",
    description: "Cancel a scheduled reminder by its task ID. Only works on reminders that haven't been triggered yet.",
    source: "core",
    category: "reminder",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The reminder/task ID to cancel (from reminder.list)" },
      },
      required: ["task_id"],
    },
    annotations: { destructiveHint: true, mutatingHint: true },
  },
];
