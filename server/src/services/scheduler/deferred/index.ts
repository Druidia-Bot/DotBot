/**
 * Deferred Tasks — Barrel Exports
 *
 * One-shot deferred tasks with retry and exponential backoff.
 *
 * Structure:
 *   schema.ts       — SQLite table creation
 *   crud.ts         — Create, read, update operations
 *   timer.ts        — Timer wheel (setTimeout for next due task)
 *   execution.ts    — Polling, execution, retry, expiration
 *   stats.ts        — Aggregated status counts
 *   time-parser.ts  — Human-readable time expression parser
 *   service.ts      — Lifecycle orchestrator (start/stop/events)
 */

// Service lifecycle
export {
  startScheduler,
  stopScheduler,
  setExecuteCallback,
  onSchedulerEvent,
  scheduleTask,
  cancelTask,
} from "./service.js";

// CRUD (direct access for consumers that need it)
export { getTask, getUserTasks, getDueTasks } from "./crud.js";

// Stats
export { getStats } from "./stats.js";
export type { SchedulerStats } from "./stats.js";

// Time parser
export { parseScheduleTime } from "./time-parser.js";
