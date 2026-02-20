/**
 * Heartbeat Scheduler Integration — Pure Functions
 *
 * Fetches scheduled/deferred tasks from the scheduler and formats them
 * as LLM prompt context for the heartbeat check.
 *
 * No WS or transport dependencies — pure data transformation.
 */

import { createComponentLogger } from "#logging.js";
import { getUserTasks, getDueTasks } from "../scheduler/index.js";
import { listRecurringTasks } from "../scheduler/index.js";
import type { RecurringTask } from "../scheduler/index.js";

const log = createComponentLogger("heartbeat.scheduler");

// ============================================
// TYPES
// ============================================

export interface ScheduledTaskCounts {
  due: number;
  upcoming: number;
  total: number;
}

// ============================================
// DATA FETCHING
// ============================================

/**
 * Fetch scheduler data once per heartbeat (avoids duplicate DB queries).
 */
export function fetchSchedulerData(userId: string): {
  dueTasks: any[];
  scheduledTasks: any[];
  recurringProblems: RecurringTask[];
} {
  try {
    const dueTasks = getDueTasks().filter((t) => t.userId === userId);
    const scheduledTasks = getUserTasks(userId, "scheduled");
    const recurringProblems = fetchRecurringTaskProblems(userId);
    return { dueTasks, scheduledTasks, recurringProblems };
  } catch (error) {
    log.debug("Could not fetch scheduled tasks for heartbeat", { error });
    return { dueTasks: [], scheduledTasks: [], recurringProblems: [] };
  }
}

/**
 * Find recurring tasks that have problems: recent failures or paused status.
 * These need to be surfaced to the user via the heartbeat.
 */
function fetchRecurringTaskProblems(userId: string): RecurringTask[] {
  try {
    const active = listRecurringTasks(userId, "active");
    const paused = listRecurringTasks(userId, "paused");
    const all = [...active, ...paused];
    return all.filter(t => t.consecutiveFailures > 0 || t.status === "paused");
  } catch {
    return [];
  }
}

// ============================================
// PROMPT BUILDING
// ============================================

/**
 * Build a text summary of the user's scheduled tasks for injection into the LLM prompt.
 * Returns an empty string if no tasks exist (keeps prompt clean).
 */
export function buildScheduledTaskSummary(
  dueTasks: any[],
  scheduledTasks: any[],
  recurringProblems: RecurringTask[] = [],
): string {
  // Nothing to report
  if (dueTasks.length === 0 && scheduledTasks.length === 0 && recurringProblems.length === 0) return "";

  const lines: string[] = ["\n## Scheduled Tasks"];

  if (dueTasks.length > 0) {
    lines.push(`**${dueTasks.length} task(s) are NOW DUE:**`);
    for (const task of dueTasks.slice(0, 5)) {
      const age = Math.round(
        (Date.now() - task.scheduledFor.getTime()) / 60000,
      );
      lines.push(
        `- [${task.priority}] "${task.originalPrompt.substring(0, 80)}" — due ${
          age > 0 ? `${age}m ago` : "now"
        } (by ${task.deferredBy})`,
      );
    }
    if (dueTasks.length > 5) {
      lines.push(`  ...and ${dueTasks.length - 5} more`);
    }
  }

  // Show upcoming tasks within the next hour (not yet due)
  const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);
  const upcoming = scheduledTasks.filter(
    (t) => t.scheduledFor > new Date() && t.scheduledFor <= oneHourFromNow,
  );
  if (upcoming.length > 0) {
    lines.push(`\n**${upcoming.length} task(s) coming up in the next hour:**`);
    for (const task of upcoming.slice(0, 3)) {
      const minsUntil = Math.round(
        (task.scheduledFor.getTime() - Date.now()) / 60000,
      );
      lines.push(
        `- [${task.priority}] "${task.originalPrompt.substring(
          0,
          80,
        )}" — in ${minsUntil}m`,
      );
    }
  }

  // Surface recurring task failures/pauses
  if (recurringProblems.length > 0) {
    lines.push(`\n**⚠️ Recurring Task Problems (${recurringProblems.length}):**`);
    for (const task of recurringProblems) {
      const status = task.status === "paused"
        ? `PAUSED after ${task.consecutiveFailures} failures`
        : `${task.consecutiveFailures} consecutive failure(s)`;
      const error = task.lastError ? ` — Last error: ${task.lastError.substring(0, 120)}` : "";
      lines.push(`- "${task.name}" (${task.id}): ${status}${error}`);
    }
    lines.push("Tell the user about these recurring task problems and suggest they check the task or re-run it.");
  }

  lines.push("");
  return lines.join("\n");
}

// ============================================
// TASK COUNTS
// ============================================

/**
 * Get task counts for the HeartbeatResult payload.
 */
export function getScheduledTaskCounts(
  dueTasks: any[],
  scheduledTasks: any[],
): ScheduledTaskCounts {
  return {
    due: dueTasks.length,
    upcoming: scheduledTasks.length - dueTasks.length,
    total: scheduledTasks.length,
  };
}
