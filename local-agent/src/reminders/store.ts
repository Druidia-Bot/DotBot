/**
 * Local Reminders Store
 * 
 * Persists reminders as JSON in ~/.bot/reminders.json on the user's machine.
 * No server involvement — CRUD is direct file I/O.
 * 
 * The periodic manager checks for due reminders every poll cycle
 * and fires notifications (console + Discord).
 */

import { promises as fs } from "fs";
import path from "path";
import { homedir } from "os";
import { nanoid } from "nanoid";

// ============================================
// TYPES
// ============================================

export interface Reminder {
  id: string;
  message: string;
  scheduledFor: string;  // ISO 8601
  priority: "P0" | "P1" | "P2" | "P3";
  status: "scheduled" | "triggered" | "cancelled";
  createdAt: string;     // ISO 8601
  triggeredAt?: string;  // ISO 8601, set when fired
}

// ============================================
// CONSTANTS
// ============================================

const REMINDERS_PATH = path.join(homedir(), ".bot", "reminders.json");
const MAX_TRIGGERED_AGE_MS = 7 * 24 * 60 * 60 * 1000; // Prune triggered reminders older than 7 days

// ============================================
// FILE I/O
// ============================================

async function readReminders(): Promise<Reminder[]> {
  try {
    const data = await fs.readFile(REMINDERS_PATH, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function writeReminders(reminders: Reminder[]): Promise<void> {
  await fs.mkdir(path.dirname(REMINDERS_PATH), { recursive: true });
  await fs.writeFile(REMINDERS_PATH, JSON.stringify(reminders, null, 2), "utf-8");
}

// ============================================
// CRUD
// ============================================

/**
 * Create a new reminder.
 */
export async function createReminder(params: {
  message: string;
  scheduledFor: string;
  priority?: string;
}): Promise<Reminder> {
  const reminders = await readReminders();

  const reminder: Reminder = {
    id: `rem_${nanoid(12)}`,
    message: params.message,
    scheduledFor: params.scheduledFor,
    priority: (params.priority as Reminder["priority"]) || "P1",
    status: "scheduled",
    createdAt: new Date().toISOString(),
  };

  reminders.push(reminder);
  await writeReminders(reminders);
  return reminder;
}

/**
 * List reminders, optionally filtered by status.
 */
export async function listReminders(statusFilter?: string): Promise<Reminder[]> {
  const reminders = await readReminders();
  if (!statusFilter || statusFilter === "all") return reminders;
  return reminders.filter(r => r.status === statusFilter);
}

/**
 * Cancel a scheduled reminder.
 */
export async function cancelReminder(id: string): Promise<boolean> {
  const reminders = await readReminders();
  const idx = reminders.findIndex(r => r.id === id && r.status === "scheduled");
  if (idx === -1) return false;

  reminders[idx].status = "cancelled";
  await writeReminders(reminders);
  return true;
}

/**
 * Get a single reminder by ID.
 */
export async function getReminder(id: string): Promise<Reminder | null> {
  const reminders = await readReminders();
  return reminders.find(r => r.id === id) || null;
}

// ============================================
// DUE REMINDERS (called by periodic check)
// ============================================

/**
 * Get all reminders that are due (scheduled_for <= now).
 * Returns only reminders with status "scheduled".
 */
export async function getDueReminders(): Promise<Reminder[]> {
  const reminders = await readReminders();
  const now = Date.now();
  return reminders.filter(
    r => r.status === "scheduled" && new Date(r.scheduledFor).getTime() <= now
  );
}

/**
 * Mark reminders as triggered (after notifying the user).
 */
export async function markTriggered(ids: string[]): Promise<void> {
  const reminders = await readReminders();
  const now = new Date().toISOString();

  for (const r of reminders) {
    if (ids.includes(r.id)) {
      r.status = "triggered";
      r.triggeredAt = now;
    }
  }

  // Prune old triggered/cancelled reminders to keep file size reasonable
  const cutoff = Date.now() - MAX_TRIGGERED_AGE_MS;
  const pruned = reminders.filter(r => {
    if (r.status === "scheduled") return true;
    const age = r.triggeredAt ? new Date(r.triggeredAt).getTime() : new Date(r.createdAt).getTime();
    return age > cutoff;
  });

  await writeReminders(pruned);
}

/**
 * Get count of scheduled (pending) reminders.
 */
export async function getScheduledCount(): Promise<number> {
  const reminders = await readReminders();
  return reminders.filter(r => r.status === "scheduled").length;
}
