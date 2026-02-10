/**
 * Reminder Checker — Periodic Task
 * 
 * Lightweight periodic task that checks ~/.bot/reminders.json for due reminders.
 * No LLM needed — just compares scheduled times against the current clock.
 * 
 * When a reminder is due:
 * 1. Logs to console
 * 2. Sends to Discord #updates channel (if configured)
 * 3. Marks the reminder as triggered in the store
 * 
 * Registered with the periodic manager alongside heartbeat and sleep cycle.
 * Runs on every poll cycle (15s) when idle, but the actual check is instant
 * (just reading a JSON file and comparing timestamps).
 */

import { getDueReminders, markTriggered } from "./store.js";
import type { Reminder } from "./store.js";

// ============================================
// STATE
// ============================================

let notifyCallback: ((reminder: Reminder) => void) | null = null;

// ============================================
// INITIALIZATION
// ============================================

/**
 * Set the callback for when a reminder fires.
 * Called from index.ts to wire up console + Discord notifications.
 */
export function setReminderNotifyCallback(cb: (reminder: Reminder) => void): void {
  notifyCallback = cb;
}

// ============================================
// CHECK (called by periodic manager)
// ============================================

/**
 * Check for due reminders and fire notifications.
 * This is the run() function registered with the periodic manager.
 */
export async function checkReminders(): Promise<void> {
  const due = await getDueReminders();
  if (due.length === 0) return;

  // Notify for each due reminder
  for (const reminder of due) {
    console.log(`\n[Reminder] ${priorityLabel(reminder.priority)} ${reminder.message}`);
    console.log(`  Scheduled for: ${reminder.scheduledFor}`);

    if (notifyCallback) {
      notifyCallback(reminder);
    }
  }

  // Mark them all as triggered
  await markTriggered(due.map(r => r.id));
}

/**
 * Gate function: always allow reminder checks (they're instant).
 * The periodic manager already handles idle gating.
 */
export function canCheckReminders(): boolean {
  return true;
}

// ============================================
// HELPERS
// ============================================

function priorityLabel(priority: string): string {
  switch (priority) {
    case "P0": return "🚨";
    case "P1": return "🔔";
    case "P2": return "📌";
    case "P3": return "📝";
    default: return "🔔";
  }
}
