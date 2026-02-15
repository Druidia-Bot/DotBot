/**
 * Recurring Tasks — Timer Wheel
 *
 * Arms a single setTimeout for the next due recurring task.
 * Re-armed after every mutation (create, cancel, pause, resume, execute).
 */

import * as db from "../../../db/index.js";
import { createComponentLogger } from "#logging.js";

const log = createComponentLogger("recurring.timer");

/** Maximum delay for setTimeout (Node.js limit: ~24.8 days) */
const MAX_TIMEOUT_MS = 2_147_483_647;

let nextPollTimer: ReturnType<typeof setTimeout> | null = null;
let pollCallback: (() => Promise<void>) | null = null;
let isRunning = false;

/**
 * Set the running state. Timer only arms when running.
 */
export function setTimerRunning(running: boolean): void {
  isRunning = running;
  if (!running && nextPollTimer) {
    clearTimeout(nextPollTimer);
    nextPollTimer = null;
  }
}

/**
 * Set the callback invoked when the timer fires.
 */
export function setPollCallback(callback: () => Promise<void>): void {
  pollCallback = callback;
}

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
export function scheduleNextPoll(): void {
  if (!isRunning) return;

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
    if (pollCallback) await pollCallback();
    scheduleNextPoll(); // Re-arm for the next batch
  }, delayMs);

  log.debug("Recurring poll armed", { delayMs, nextDue: nextDue.toISOString() });
}
