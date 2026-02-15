/**
 * Scheduler Types
 * 
 * Types for the task deferral and scheduling system.
 */

// ============================================
// DEFERRED TASK
// ============================================

export interface DeferredTask {
  /** Unique task ID (from DB) */
  id: string;
  /** User who owns this task */
  userId: string;
  /** Original session that created this task */
  sessionId: string;
  /** The original prompt/request */
  originalPrompt: string;
  /** Which persona deferred it */
  deferredBy: string;
  /** Why it was deferred */
  deferReason: string;
  /** When to retry */
  scheduledFor: Date;
  /** How many times we've tried */
  attemptCount: number;
  /** Max retry attempts */
  maxAttempts: number;
  /** Priority level */
  priority: "P0" | "P1" | "P2" | "P3";
  /** Current status */
  status: "scheduled" | "executing" | "completed" | "failed" | "expired";
  /** Any context to carry forward */
  context?: Record<string, unknown>;
  /** Thread IDs relevant to this task */
  threadIds?: string[];
  /** Result if completed */
  result?: string;
  /** Error if failed */
  error?: string;
  /** When it was created */
  createdAt: Date;
  /** When it was last updated */
  updatedAt: Date;
}

// ============================================
// SCHEDULER EVENTS
// ============================================

export type SchedulerEventType =
  | "task_scheduled"
  | "task_executing"
  | "task_completed"
  | "task_failed"
  | "task_expired"
  | "task_cancelled";

export interface SchedulerEvent {
  type: SchedulerEventType;
  taskId: string;
  userId: string;
  timestamp: Date;
  details?: Record<string, unknown>;
}

export type SchedulerEventCallback = (event: SchedulerEvent) => void;

// ============================================
// SCHEDULER CONFIG
// ============================================

export interface SchedulerConfig {
  /** How often to check for due tasks (ms) */
  pollIntervalMs: number;
  /** Maximum concurrent task executions */
  maxConcurrent: number;
  /** Default max attempts for deferred tasks */
  defaultMaxAttempts: number;
  /** How long before a scheduled task expires without execution (ms) */
  expirationMs: number;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  pollIntervalMs: 15_000,       // Check every 15 seconds
  maxConcurrent: 3,             // Max 3 concurrent deferred tasks
  expirationMs: 24 * 60 * 60 * 1000, // 24 hours
  defaultMaxAttempts: 3,
};
