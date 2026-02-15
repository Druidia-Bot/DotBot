/**
 * Recurring Tasks — Barrel Exports
 *
 * Re-exports the public API from all recurring task submodules.
 */

// Lifecycle & public task API
export {
  startRecurringScheduler,
  stopRecurringScheduler,
  setRecurringExecuteCallback,
  onRecurringEvent,
  createRecurringTask,
  cancelRecurringTask,
  pauseRecurringTask,
  resumeRecurringTask,
  executeTaskNow,
  getRecurringTask,
  listRecurringTasks,
  getOfflineResults,
  getUpcomingRecurringTasks,
  pruneOldCancelledTasks,
  calculateNextRun,
} from "./service.js";

// Stats
export { getRecurringStats } from "./stats.js";
export type { RecurringStats } from "./stats.js";
