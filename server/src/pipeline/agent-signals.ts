/**
 * Agent Signals — In-Memory Signal Queue + Abort Controllers
 *
 * Provides two mechanisms for controlling running agents:
 * 1. Signal queue: user instructions injected into replan() between steps
 * 2. Abort controllers: immediate stop signal checked between steps + in tool loop
 *
 * Both are keyed by agentId. Lifecycle:
 *   registerAgent()  → called when executor starts
 *   unregisterAgent() → called when executor finishes (success, fail, or stop)
 */

import { createComponentLogger } from "../logging.js";

const log = createComponentLogger("agent-signals");

// ============================================
// SIGNAL QUEUE
// ============================================

const signalQueue = new Map<string, string[]>();

/**
 * Push a user instruction into an agent's signal queue.
 * The next replan() call will drain and incorporate it.
 */
export function pushSignal(agentId: string, message: string): void {
  const queue = signalQueue.get(agentId);
  if (queue) {
    queue.push(message);
    log.info("Signal pushed", { agentId, queueLength: queue.length });
  } else {
    log.warn("Signal pushed for unregistered agent — creating queue", { agentId });
    signalQueue.set(agentId, [message]);
  }
}

/**
 * Drain all pending signals for an agent. Returns the signals and clears the queue.
 * Returns empty array if no signals pending.
 */
export function drainSignals(agentId: string): string[] {
  const queue = signalQueue.get(agentId);
  if (!queue || queue.length === 0) return [];

  const drained = [...queue];
  queue.length = 0;
  log.info("Signals drained", { agentId, count: drained.length });
  return drained;
}

/**
 * Check if an agent has pending signals without draining them.
 */
export function hasPendingSignals(agentId: string): boolean {
  const queue = signalQueue.get(agentId);
  return !!queue && queue.length > 0;
}

// ============================================
// ABORT CONTROLLERS
// ============================================

const abortControllers = new Map<string, AbortController>();

/**
 * Get the AbortSignal for an agent. Returns undefined if agent is not registered.
 * Check `signal.aborted` between steps and inside the tool loop.
 */
export function getAbortSignal(agentId: string): AbortSignal | undefined {
  return abortControllers.get(agentId)?.signal;
}

/**
 * Abort a running agent. The signal is checked between steps and in the tool loop.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function abortAgent(agentId: string): void {
  const controller = abortControllers.get(agentId);
  if (!controller) {
    log.warn("Abort requested for unregistered agent", { agentId });
    return;
  }
  if (controller.signal.aborted) {
    log.info("Agent already aborted", { agentId });
    return;
  }
  controller.abort();
  log.info("Agent abort signal fired", { agentId });
}

// ============================================
// LIFECYCLE
// ============================================

/**
 * Register an agent for signal handling. Call when executor starts.
 * Returns the AbortController (caller can also use getAbortSignal).
 */
export function registerAgent(agentId: string): AbortController {
  // Clean up any stale registration
  if (abortControllers.has(agentId)) {
    log.warn("Agent already registered — replacing", { agentId });
    unregisterAgent(agentId);
  }

  const controller = new AbortController();
  abortControllers.set(agentId, controller);
  signalQueue.set(agentId, []);
  log.info("Agent registered for signals", { agentId });
  return controller;
}

/**
 * Unregister an agent. Call when executor finishes (any outcome).
 * Cleans up both the signal queue and abort controller.
 */
export function unregisterAgent(agentId: string): void {
  abortControllers.delete(agentId);
  signalQueue.delete(agentId);
  log.info("Agent unregistered from signals", { agentId });
}

/**
 * Check if an agent is currently registered (i.e., has an active executor).
 */
export function isAgentRegistered(agentId: string): boolean {
  return abortControllers.has(agentId);
}

/**
 * Get all currently registered agent IDs. Useful for heartbeat/monitoring.
 */
export function getRegisteredAgentIds(): string[] {
  return Array.from(abortControllers.keys());
}

// ============================================
// TASK QUEUE (for QUEUE routing decisions)
// ============================================

export interface QueuedTaskEntry {
  id: string;
  request: string;
  addedAt: string;
}

const taskQueues = new Map<string, QueuedTaskEntry[]>();

/**
 * Queue a task to run after the current agent completes.
 * The queue is keyed by agentId — tasks are bound to a specific agent's workspace.
 */
export function queueTask(agentId: string, entry: QueuedTaskEntry): void {
  let queue = taskQueues.get(agentId);
  if (!queue) {
    queue = [];
    taskQueues.set(agentId, queue);
  }
  queue.push(entry);
  log.info("Task queued", { agentId, taskId: entry.id, queueLength: queue.length });
}

/**
 * Drain all queued tasks for an agent. Returns the tasks and clears the queue.
 * Called after executor completes to check for follow-up work.
 */
export function drainTaskQueue(agentId: string): QueuedTaskEntry[] {
  const queue = taskQueues.get(agentId);
  if (!queue || queue.length === 0) return [];

  const drained = [...queue];
  taskQueues.delete(agentId);
  log.info("Task queue drained", { agentId, count: drained.length });
  return drained;
}

/**
 * Check if an agent has queued tasks without draining them.
 */
export function hasQueuedTasks(agentId: string): boolean {
  const queue = taskQueues.get(agentId);
  return !!queue && queue.length > 0;
}

// ============================================
// ROUTING LOCK (prevents concurrent routing per device)
// ============================================

const routingLocks = new Map<string, { agentId?: string; workspacePath?: string; lockedAt: number }>();

const ROUTING_LOCK_TIMEOUT_MS = 30_000;

/**
 * Try to acquire the routing lock for a device. Returns true if acquired.
 * If another routing call is in-flight, returns false + the active agentId
 * so the caller can push a signal instead.
 */
export function tryAcquireRoutingLock(deviceId: string): { acquired: boolean; activeAgentId?: string; activeWorkspacePath?: string } {
  const existing = routingLocks.get(deviceId);
  if (existing && (Date.now() - existing.lockedAt) < ROUTING_LOCK_TIMEOUT_MS) {
    return { acquired: false, activeAgentId: existing.agentId, activeWorkspacePath: existing.workspacePath };
  }
  // Stale lock or no lock — acquire
  routingLocks.set(deviceId, { lockedAt: Date.now() });
  return { acquired: true };
}

/**
 * Release the routing lock for a device. Optionally record which agent
 * was created/targeted so subsequent rapid messages can be coalesced.
 */
export function releaseRoutingLock(deviceId: string, agentId?: string, workspacePath?: string): void {
  if (agentId) {
    // Keep the lock briefly with the agentId + workspacePath so rapid follow-ups coalesce
    routingLocks.set(deviceId, { agentId, workspacePath, lockedAt: Date.now() });
    // Auto-release after a short window
    setTimeout(() => {
      const current = routingLocks.get(deviceId);
      if (current?.agentId === agentId) {
        routingLocks.delete(deviceId);
      }
    }, 3_000);
  } else {
    routingLocks.delete(deviceId);
  }
}
