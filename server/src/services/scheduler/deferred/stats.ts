/**
 * Deferred Tasks — Stats
 *
 * Aggregated status counts for the deferred task system.
 */

import * as db from "../../../db/index.js";
import { getActiveExecutionCount } from "./execution.js";

export interface SchedulerStats {
  scheduled: number;
  executing: number;
  completed: number;
  failed: number;
  expired: number;
  activeExecutions: number;
}

export function getStats(): SchedulerStats {
  const database = db.getDatabase();

  const counts = database.prepare(`
    SELECT status, COUNT(*) as count FROM deferred_tasks GROUP BY status
  `).all() as { status: string; count: number }[];

  const stats: SchedulerStats = {
    scheduled: 0,
    executing: 0,
    completed: 0,
    failed: 0,
    expired: 0,
    activeExecutions: getActiveExecutionCount(),
  };

  for (const row of counts) {
    if (row.status in stats) {
      (stats as any)[row.status] = row.count;
    }
  }

  return stats;
}
