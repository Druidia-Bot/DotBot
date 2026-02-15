/**
 * Recurring Task Types
 *
 * Types for the server-side recurring scheduled task system.
 * These tasks persist in SQLite and run even when no client is connected.
 */

// ============================================
// SCHEDULE DEFINITION
// ============================================

export type ScheduleType = "daily" | "weekly" | "hourly" | "interval";

export interface TaskSchedule {
  type: ScheduleType;
  /** "HH:MM" local time (for daily/weekly) */
  time?: string;
  /** 0=Sun..6=Sat (for weekly) */
  dayOfWeek?: number;
  /** N minutes between runs (for interval, min 5) */
  intervalMinutes?: number;
}

// ============================================
// RECURRING TASK
// ============================================

export interface RecurringTask {
  id: string;
  userId: string;
  /** Preferred device for execution (null = any) */
  deviceId: string | null;
  name: string;
  prompt: string;
  /** Optional persona override */
  personaHint: string | null;
  scheduleType: ScheduleType;
  scheduleTime: string | null;
  scheduleDayOfWeek: number | null;
  scheduleIntervalMinutes: number | null;
  /** IANA timezone for schedule_time (e.g., "America/New_York") */
  timezone: string;
  priority: "P0" | "P1" | "P2" | "P3";
  status: "active" | "paused" | "cancelled";
  lastRunAt: Date | null;
  nextRunAt: Date;
  lastResult: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  maxFailures: number;
  /** When we last asked user about running this missed task (for 2-hour grace period) */
  missedPromptSentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================
// CREATE PARAMS
// ============================================

export interface CreateRecurringTaskParams {
  userId: string;
  deviceId?: string;
  name: string;
  prompt: string;
  personaHint?: string;
  schedule: TaskSchedule;
  timezone?: string;
  priority?: "P0" | "P1" | "P2" | "P3";
  maxFailures?: number;
}

// ============================================
// CONFIG
// ============================================

export interface RecurringSchedulerConfig {
  /** How often to check for due recurring tasks (ms) */
  pollIntervalMs: number;
  /** Maximum concurrent recurring task executions */
  maxConcurrent: number;
  /** Default max failures before auto-pause */
  defaultMaxFailures: number;
}

export const DEFAULT_RECURRING_CONFIG: RecurringSchedulerConfig = {
  pollIntervalMs: 30_000,     // Check every 30 seconds
  maxConcurrent: 2,           // Max 2 concurrent recurring tasks
  defaultMaxFailures: 3,
};

// ============================================
// EVENTS
// ============================================

export type RecurringEventType =
  | "recurring_created"
  | "recurring_executing"
  | "recurring_completed"
  | "recurring_failed"
  | "recurring_paused"
  | "recurring_cancelled"
  | "recurring_resumed"
  | "recurring_missed";

export interface RecurringEvent {
  type: RecurringEventType;
  taskId: string;
  userId: string;
  taskName: string;
  timestamp: Date;
  details?: Record<string, unknown>;
}

export type RecurringEventCallback = (event: RecurringEvent) => void;
