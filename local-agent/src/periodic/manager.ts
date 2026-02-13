/**
 * Unified Periodic Manager
 * 
 * Single coordinator for all periodic background tasks on the local agent.
 * Replaces the independent timer/idle management in heartbeat.ts and sleep-cycle.ts.
 * 
 * Responsibilities:
 * - Single idle tracker (lastActivityAt) — one notifyActivity() for the whole agent
 * - Task registry with configurable intervals and initial delays
 * - Overlap prevention — only one periodic task runs at a time
 * - Single poll loop that checks which tasks are due
 * - Centralized start/stop lifecycle
 * 
 * The actual task logic (reading HEARTBEAT.md, consolidating memory) stays in
 * heartbeat.ts and sleep-cycle.ts. They just expose run() functions that the
 * manager calls at the right time.
 */

// ============================================
// TYPES
// ============================================

export interface PeriodicTaskDef {
  /** Unique task identifier */
  id: string;
  /** Human-readable name for logs */
  name: string;
  /** How often to run (ms) */
  intervalMs: number;
  /** Delay before first run after manager starts (ms) */
  initialDelayMs: number;
  /** Whether this task is active */
  enabled: boolean;
  /**
   * The work function. The manager passes the current idle duration (ms).
   * Return value is ignored; throw to signal failure (manager catches and logs).
   */
  run: (idleDurationMs: number) => Promise<void>;
  /**
   * Optional gate: if provided, the manager calls this before run().
   * Return false to skip this cycle (e.g., backoff, active hours check).
   */
  canRun?: () => boolean;
  /**
   * If true, run this task even when the system is not idle.
   * Use for time-based tasks like reminders that must fire on schedule.
   */
  bypassIdleCheck?: boolean;
}

export interface ManagerStatus {
  running: boolean;
  idleMs: number;
  currentlyRunning: string | null;
  tasks: Array<{
    id: string;
    name: string;
    enabled: boolean;
    lastRunAt: number;
    msSinceLastRun: number;
    intervalMs: number;
  }>;
}

// ============================================
// CONSTANTS
// ============================================

/** How often the manager checks for due tasks */
const POLL_INTERVAL_MS = 15_000; // 15 seconds

/** Minimum idle time before any periodic task can run */
const DEFAULT_IDLE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

// ============================================
// STATE
// ============================================

let tasks: PeriodicTaskDef[] = [];
let lastActivityAt: number = Date.now();
let pollTimer: NodeJS.Timeout | null = null;
let currentlyRunning: string | null = null;
let managerRunning = false;
const lastRunAt = new Map<string, number>();
const initialDelayTimers: NodeJS.Timeout[] = [];

// ============================================
// LIFECYCLE
// ============================================

/**
 * Start the periodic manager with a set of tasks.
 * Idempotent — stops any existing manager first.
 */
export function startPeriodicManager(taskDefs: PeriodicTaskDef[]): void {
  stopPeriodicManager();

  tasks = taskDefs;
  lastActivityAt = Date.now();
  lastRunAt.clear();
  currentlyRunning = null;
  managerRunning = true;

  // Schedule initial-delay runs
  for (const task of tasks) {
    if (!task.enabled) continue;
    if (task.initialDelayMs > 0) {
      const t = setTimeout(() => {
        pollSingleTask(task).catch(() => {});
      }, task.initialDelayMs);
      initialDelayTimers.push(t);
    }
  }

  // Start the poll loop
  pollTimer = setInterval(() => {
    poll().catch(() => {});
  }, POLL_INTERVAL_MS);

  const enabledNames = tasks.filter(t => t.enabled).map(t => t.name);
  console.log(`[Periodic] Manager started — ${enabledNames.length} task(s): ${enabledNames.join(", ")}`);
}

/**
 * Stop the periodic manager and all tasks.
 */
export function stopPeriodicManager(): void {
  if (!managerRunning) return;

  managerRunning = false;

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  for (const t of initialDelayTimers) {
    clearTimeout(t);
  }
  initialDelayTimers.length = 0;

  tasks = [];
  lastRunAt.clear();
  currentlyRunning = null;

  console.log("[Periodic] Manager stopped");
}

// ============================================
// ACTIVITY TRACKING
// ============================================

/**
 * Notify the manager that the system is active (user interaction, server request, etc.).
 * Resets the idle clock so periodic tasks don't run during active use.
 */
export function notifyActivity(): void {
  lastActivityAt = Date.now();
}

/**
 * Get how long the system has been idle (ms since last activity).
 */
export function getIdleDurationMs(): number {
  return Date.now() - lastActivityAt;
}

// ============================================
// STATUS QUERIES
// ============================================

/**
 * Returns true if any periodic task is currently running.
 */
export function isAnyTaskRunning(): boolean {
  return currentlyRunning !== null;
}

/**
 * Returns true if a specific task is currently running.
 */
export function isTaskRunning(taskId: string): boolean {
  return currentlyRunning === taskId;
}

/**
 * Get the full manager status for observability.
 */
export function getManagerStatus(): ManagerStatus {
  const now = Date.now();
  return {
    running: managerRunning,
    idleMs: now - lastActivityAt,
    currentlyRunning,
    tasks: tasks.map(t => ({
      id: t.id,
      name: t.name,
      enabled: t.enabled,
      lastRunAt: lastRunAt.get(t.id) || 0,
      msSinceLastRun: now - (lastRunAt.get(t.id) || 0),
      intervalMs: t.intervalMs,
    })),
  };
}

// ============================================
// POLL LOOP
// ============================================

async function poll(): Promise<void> {
  if (!managerRunning) return;

  // If something is already running, skip this poll
  if (currentlyRunning) return;

  // Check idle status
  const idleMs = Date.now() - lastActivityAt;
  const systemIdle = idleMs >= DEFAULT_IDLE_THRESHOLD_MS;

  // Run ALL due tasks in priority order (registration order)
  // Fixed: Previously only ran ONE task per poll, causing starvation where
  // short-interval tasks (reminder-check at 15s) monopolized the loop and
  // starved longer-interval tasks (sleep-cycle at 30min, never ran since Feb 8)
  for (const task of tasks) {
    if (!task.enabled) continue;

    // Skip if system is not idle, UNLESS task bypasses idle check
    if (!systemIdle && !task.bypassIdleCheck) continue;

    const last = lastRunAt.get(task.id) || 0;
    const elapsed = Date.now() - last;
    if (elapsed < task.intervalMs) continue;

    // Task is due — run it (continue checking remaining tasks)
    await runTask(task, idleMs);
  }
}

/**
 * Poll a single task (used for initial-delay runs).
 * Respects idle and overlap constraints.
 */
async function pollSingleTask(task: PeriodicTaskDef): Promise<void> {
  if (!managerRunning) return;
  if (currentlyRunning) return;
  if (!task.enabled) return;

  const idleMs = Date.now() - lastActivityAt;
  const systemIdle = idleMs >= DEFAULT_IDLE_THRESHOLD_MS;

  // Skip if system is not idle, UNLESS task bypasses idle check
  if (!systemIdle && !task.bypassIdleCheck) return;

  // Only run if not already run (initial delay shouldn't re-run if poll already ran it)
  const last = lastRunAt.get(task.id) || 0;
  if (Date.now() - last < task.intervalMs) return;

  await runTask(task, idleMs);
}

async function runTask(task: PeriodicTaskDef, idleMs: number): Promise<void> {
  // Check optional gate
  if (task.canRun && !task.canRun()) return;

  currentlyRunning = task.id;
  lastRunAt.set(task.id, Date.now());

  try {
    await task.run(idleMs);
  } catch (err) {
    console.error(`[Periodic] Task "${task.name}" failed:`, err);
  } finally {
    currentlyRunning = null;
  }
}

// ============================================
// TESTING HELPERS
// ============================================

/** Reset all state — for testing only */
export function _resetForTesting(): void {
  stopPeriodicManager();
  lastActivityAt = Date.now();
}
