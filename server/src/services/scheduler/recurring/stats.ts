/**
 * Recurring Tasks — Stats
 *
 * Aggregated status counts for the recurring task system.
 */

import * as db from "../../../db/index.js";
import { getActiveExecutionCount } from "./execution.js";

export interface RecurringStats {
  active: number;
  paused: number;
  cancelled: number;
  totalExecutions: number;
  activeExecutions: number;
}

export function getRecurringStats(): RecurringStats {
  const database = db.getDatabase();

  const counts = database.prepare(`
    SELECT status, COUNT(*) as count FROM recurring_tasks GROUP BY status
  `).all() as { status: string; count: number }[];

  const stats: RecurringStats = {
    active: 0,
    paused: 0,
    cancelled: 0,
    totalExecutions: 0,
    activeExecutions: getActiveExecutionCount(),
  };

  for (const row of counts) {
    if (row.status === "active") stats.active = row.count;
    else if (row.status === "paused") stats.paused = row.count;
    else if (row.status === "cancelled") stats.cancelled = row.count;
  }

  // Total executions = sum of all tasks that have been run at least once
  const totalRow = database.prepare(`
    SELECT COUNT(*) as count FROM recurring_tasks WHERE last_run_at IS NOT NULL
  `).get() as { count: number };
  stats.totalExecutions = totalRow.count;

  return stats;
}
