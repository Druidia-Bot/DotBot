/**
 * Agent Task Registry
 * 
 * Tracks background agent loops so the main thread stays responsive.
 * Each device can have multiple concurrent agent loops.
 * 
 * Tasks are named so the user can target corrections at specific loops.
 * Injection routing: status query → server response; name match (multi-task only); else → receptionist.
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "../logging.js";
import type { AgentRunResult } from "./runner.js";
import { ensureWatchdog, getRouterLLM, setWatchdogLLM } from "./watchdog.js";

const log = createComponentLogger("agent-tasks");

// Re-export so existing call sites don't break
export { setWatchdogLLM };

// ============================================
// TYPES
// ============================================

export interface AgentTask {
  /** Unique task ID */
  id: string;
  /** Short human-readable name (e.g. "Build portfolio site") */
  name: string;
  /** Longer description of what the agent is doing */
  description: string;
  /** Device that spawned this task */
  deviceId: string;
  /** User who owns this task */
  userId: string;
  /** Current status */
  status: "running" | "completed" | "failed" | "cancelled" | "blocked";
  /** Original user prompt */
  prompt: string;
  /** Which persona is working on this */
  personaId: string;
  /** Shared injection queue — tool loop reads from this */
  injectionQueue: string[];
  /** When the task was spawned */
  startedAt: number;
  /** When the task finished */
  completedAt?: number;
  /** The background promise (not awaited by the main thread) */
  promise: Promise<AgentRunResult>;
  /** AbortController — watchdog can abort the current blocking operation */
  abortController: AbortController;
  /** Last activity timestamp — updated on each tool call/result */
  lastActivityAt: number;
  /** Recent activity log (last 15 entries) for investigator context */
  recentActivity: string[];
  /** Watchdog escalation phase: 0=none, 1=nudged, 2=aborted+investigated, 3=killed */
  watchdogPhase: number;
  /** When blocked: reason the task is waiting for user input */
  waitReason?: string;
  /** When blocked: description of what kind of response would unblock this task */
  resumeHint?: string;
  /** When blocked: resolver that unblocks the tool loop when called with user's response */
  waitResolve?: (response: string) => void;
  /** When blocked: auto-timeout timer that fails the wait if user doesn't respond */
  waitTimer?: ReturnType<typeof setTimeout>;
}

/** Result of injection routing */
export interface InjectionRouteResult {
  /** The task the message was routed to (null if no active tasks) */
  task: AgentTask | null;
  /** How the route was determined */
  method: "single_task" | "name_match" | "most_recent" | "status_query" | "blocked_resume" | "none";
}

// ============================================
// REGISTRY
// ============================================

/** All tasks by task ID */
const tasks = new Map<string, AgentTask>();

/** Device → active task IDs (multiple concurrent loops allowed) */
const deviceActiveTasks = new Map<string, string[]>();

// ============================================
// PUBLIC API
// ============================================

/**
 * Spawn a new background agent task for a device.
 * Returns the task immediately — the promise runs in the background.
 * Multiple tasks can run concurrently per device.
 */
export function spawnTask(
  deviceId: string,
  userId: string,
  prompt: string,
  personaId: string,
  name: string,
  description: string,
  runFn: (injectionQueue: string[], agentTaskId: string, abortSignal: AbortSignal) => Promise<AgentRunResult>
): AgentTask {
  const taskId = `agent_${nanoid(12)}`;
  const injectionQueue: string[] = [];
  const abortController = new AbortController();

  // Start the background work — pass the shared injection queue, task ID, and abort signal
  const promise = runFn(injectionQueue, taskId, abortController.signal).then(result => {
    completeTask(taskId, result.success ? "completed" : "failed");
    return result;
  }).catch(error => {
    log.error(`Agent task ${taskId} failed`, { error });
    completeTask(taskId, "failed");
    throw error;
  });

  const now = Date.now();
  const task: AgentTask = {
    id: taskId,
    name,
    description,
    deviceId,
    userId,
    status: "running",
    prompt,
    personaId,
    injectionQueue,
    startedAt: now,
    promise,
    abortController,
    lastActivityAt: now,
    recentActivity: [],
    watchdogPhase: 0,
  };

  tasks.set(taskId, task);

  // Add to device's active task list
  const active = deviceActiveTasks.get(deviceId) || [];
  active.push(taskId);
  deviceActiveTasks.set(deviceId, active);

  // Ensure watchdog is running
  ensureWatchdog(() => Array.from(tasks.values()));

  log.info(`Spawned agent task`, { taskId, name, deviceId, personaId, prompt: prompt.substring(0, 80) });
  return task;
}

/**
 * Record activity on a task — called by tool loop callbacks to track progress.
 * Updates lastActivityAt and appends to recentActivity ring buffer.
 */
export function recordTaskActivity(taskId: string, activity: string): void {
  const task = tasks.get(taskId);
  if (!task || task.status !== "running") return;

  task.lastActivityAt = Date.now();
  task.recentActivity.push(`[${new Date().toISOString().substring(11, 19)}] ${activity}`);
  // Keep only the last 15 entries
  if (task.recentActivity.length > 15) {
    task.recentActivity.splice(0, task.recentActivity.length - 15);
  }
}

/**
 * Look up a task by ID. Used by the abort signal getter closure.
 */
export function getTaskById(taskId: string): AgentTask | undefined {
  return tasks.get(taskId);
}

/**
 * Inject a user message into a specific agent task.
 * Returns true if the task was found and running.
 */
export function injectMessageToTask(taskId: string, message: string): boolean {
  const task = tasks.get(taskId);
  if (!task || task.status !== "running") return false;

  task.injectionQueue.push(message);
  log.info(`Injected message into task ${taskId} ("${task.name}")`, {
    deviceId: task.deviceId,
    messageLength: message.length,
    queueDepth: task.injectionQueue.length,
  });
  return true;
}

/** Clear blocked-task state fields and cancel the auto-timeout timer. */
function clearBlockedState(task: AgentTask): void {
  if (task.waitTimer) clearTimeout(task.waitTimer);
  task.waitReason = undefined;
  task.resumeHint = undefined;
  task.waitResolve = undefined;
  task.waitTimer = undefined;
}

/**
 * Block a running task — it's waiting for user input.
 * Returns a Promise that resolves with the user's response.
 */
export function blockTask(
  taskId: string,
  reason: string,
  resumeHint?: string,
  timeoutMs?: number
): Promise<string> {
  const task = tasks.get(taskId);
  if (!task || task.status !== "running") {
    return Promise.reject(new Error(`Cannot block task ${taskId} — not running`));
  }

  const effectiveTimeout = timeoutMs || 30 * 60_000;
  return new Promise<string>((resolve) => {
    task.status = "blocked";
    task.waitReason = reason;
    task.resumeHint = resumeHint || reason;
    task.waitResolve = resolve;
    task.lastActivityAt = Date.now();

    task.waitTimer = setTimeout(() => {
      if (task.status === "blocked" && task.waitResolve) {
        log.warn(`Blocked task timed out`, { taskId, name: task.name, timeoutMs: effectiveTimeout });
        const r = task.waitResolve;
        clearBlockedState(task);
        task.status = "running";
        r(`[TIMEOUT] No response within ${Math.round(effectiveTimeout / 60_000)} minutes. Summarize progress and let the user know they can continue later.`);
      }
    }, effectiveTimeout);

    log.info(`Task blocked`, { taskId, name: task.name, reason, resumeHint, timeoutMs: effectiveTimeout });
  });
}

/** Resume a blocked task with the user's response. */
export function resumeBlockedTask(taskId: string, message: string): boolean {
  const task = tasks.get(taskId);
  if (!task || task.status !== "blocked" || !task.waitResolve) return false;

  const resolve = task.waitResolve;
  clearBlockedState(task);
  task.status = "running";
  task.lastActivityAt = Date.now();
  task.watchdogPhase = 0;

  log.info(`Resuming blocked task`, { taskId, name: task.name, messageLength: message.length });
  resolve(message);
  ensureWatchdog();
  return true;
}

/** Get blocked tasks for a device. */
export function getBlockedTasksForDevice(deviceId: string): AgentTask[] {
  const taskIds = deviceActiveTasks.get(deviceId);
  if (!taskIds || taskIds.length === 0) return [];
  return taskIds
    .map(id => tasks.get(id))
    .filter((t): t is AgentTask => !!t && t.status === "blocked");
}

// ============================================
// BLOCKED TASK EVALUATION
// ============================================

/**
 * Evaluate whether a user message resolves any blocked task.
 * Uses a fast LLM call to check the message against each task's resumeHint.
 * Returns the matching task, or null if the message doesn't match any.
 */
async function evaluateBlockedTaskMatch(
  blockedTasks: AgentTask[],
  message: string
): Promise<AgentTask | null> {
  // Build the evaluation prompt
  const taskDescriptions = blockedTasks.map((t, i) =>
    `TASK_${i}: "${t.name}" — waiting for: ${t.resumeHint || t.waitReason || "user response"}`
  ).join("\n");

  // Try LLM evaluation first (most reliable)
  const llm = getRouterLLM();
  if (llm) {
    try {
      const evalPrompt = `You are a message router. Blocked tasks are waiting for specific user responses.

BLOCKED TASKS:
${taskDescriptions}

USER MESSAGE: "${message.substring(0, 500)}"

Does the user's message address or resolve ANY of the blocked tasks above?
- If YES: respond with ONLY the task label (e.g. "TASK_0")
- If NO (the message is unrelated, a new request, or off-topic): respond with ONLY "NONE"

Answer:`;

      const response = await llm.chat([
        { role: "user", content: evalPrompt }
      ], { maxTokens: 10, temperature: 0 });

      const answer = response.content.trim().toUpperCase();

      if (answer === "NONE") {
        log.info(`LLM evaluator: message does not match any blocked task`);
        return null;
      }

      // Parse TASK_N
      const match = answer.match(/TASK_(\d+)/);
      if (match) {
        const idx = parseInt(match[1], 10);
        if (idx >= 0 && idx < blockedTasks.length) {
          log.info(`LLM evaluator: message matches blocked task`, {
            taskId: blockedTasks[idx].id,
            taskName: blockedTasks[idx].name,
          });
          return blockedTasks[idx];
        }
      }

      log.warn(`LLM evaluator returned unexpected answer: "${answer}"`);
      return null;
    } catch (error) {
      log.warn(`LLM evaluation failed, falling back to heuristic`, { error });
    }
  }

  // Fallback heuristic: only match if the message looks like a response
  // (short confirmations, mentions of the task topic, etc.)
  // If it looks like a brand-new request, don't match.
  const lower = message.toLowerCase().trim();
  const looksLikeNewRequest = /^(can you|could you|please |help me|how do|what is|write |create |build |make |show me|tell me|i want|i need)/i.test(lower);

  if (looksLikeNewRequest) {
    log.info(`Heuristic: message looks like a new request, not matching any blocked task`);
    return null;
  }

  // Short confirmations likely match the most recent blocked task
  const looksLikeConfirmation = /^(done|ok|ready|yes|yep|yeah|got it|finished|completed|i did|here|pasted|entered|submitted)/i.test(lower);

  if (looksLikeConfirmation && blockedTasks.length === 1) {
    log.info(`Heuristic: short confirmation matches single blocked task`);
    return blockedTasks[0];
  }

  // Ambiguous — don't match (safer to let it fall through to receptionist)
  log.info(`Heuristic: ambiguous message, not matching any blocked task`);
  return null;
}

/**
 * Route an injection message to the right active task for a device.
 * 
 * Strategy:
 * 1. Blocked tasks → LLM evaluates if message resolves a waiting task
 * 2. Status query → server responds with task status (no injection)
 * 3. Multi-task + explicit name match → inject into named task
 * 4. Everything else → fall through to receptionist for proper routing
 */
export async function routeInjection(
  deviceId: string,
  message: string
): Promise<InjectionRouteResult> {
  const activeTasks = getActiveTasksForDevice(deviceId);
  const blockedTasks = getBlockedTasksForDevice(deviceId);

  // Blocked tasks — evaluate whether the user's message resolves one.
  // We do NOT blindly resume; "Did you know I like tacos" shouldn't unblock
  // a task waiting for a Discord token.
  if (blockedTasks.length > 0 && !isStatusQuery(message)) {
    const matchedTask = await evaluateBlockedTaskMatch(blockedTasks, message);
    if (matchedTask) {
      return { task: matchedTask, method: "blocked_resume" };
    }
    // No match — fall through to normal routing (running tasks or receptionist)
    log.info(`User message did not match any blocked task`, {
      blockedCount: blockedTasks.length,
      messagePreview: message.substring(0, 80),
    });
  }

  if (activeTasks.length === 0 && blockedTasks.length === 0) {
    return { task: null, method: "none" };
  }

  if (activeTasks.length === 0) {
    // Only blocked tasks exist but it was a status query — handle as status
    if (isStatusQuery(message) && blockedTasks.length > 0) {
      return { task: blockedTasks[0], method: "status_query" };
    }
    return { task: null, method: "none" };
  }

  // Status queries get a quick server-side response with task status.
  // Everything else gets injected into the running task — the user is
  // talking to the agent about what it's doing.
  if (isStatusQuery(message)) {
    return { task: activeTasks[0], method: "status_query" };
  }

  // Single task running → inject into it. The user is talking to the agent.
  if (activeTasks.length === 1) {
    return { task: activeTasks[0], method: "single_task" };
  }

  // Multi-task: try name match first, then fall back to most recent.
  const nameMatch = matchTaskByName(activeTasks, message);
  if (nameMatch) {
    log.info(`Injection routed by name match`, { taskId: nameMatch.id, name: nameMatch.name });
    return { task: nameMatch, method: "name_match" };
  }

  // No name match — inject into the most recently started task
  const mostRecent = activeTasks.reduce((latest, t) => t.startedAt > latest.startedAt ? t : latest);
  return { task: mostRecent, method: "most_recent" };
}

/**
 * Get all active (running) tasks for a device.
 */
export function getActiveTasksForDevice(deviceId: string): AgentTask[] {
  const taskIds = deviceActiveTasks.get(deviceId);
  if (!taskIds || taskIds.length === 0) return [];

  return taskIds
    .map(id => tasks.get(id))
    .filter((t): t is AgentTask => !!t && t.status === "running");
}

/**
 * Get a single active task for a device — returns most recent if multiple.
 * Backward-compatible convenience for single-task patterns.
 */
export function getActiveTaskForDevice(deviceId: string): AgentTask | undefined {
  const active = getActiveTasksForDevice(deviceId);
  if (active.length === 0) return undefined;
  return active.reduce((latest, t) => t.startedAt > latest.startedAt ? t : latest);
}

/**
 * Cancel a running task. Aborts the controller so the task's await chain breaks.
 */
export function cancelTask(taskId: string): void {
  const task = tasks.get(taskId);
  if (!task) return;

  if (task.status === "blocked" && task.waitResolve) {
    const r = task.waitResolve;
    clearBlockedState(task);
    r("[CANCELLED] The user cancelled this task.");
  }

  task.status = "cancelled";
  task.completedAt = Date.now();
  task.abortController.abort();
  removeFromDeviceList(task.deviceId, taskId);

  log.info(`Cancelled agent task`, { taskId, name: task.name, deviceId: task.deviceId });
}

/** Cancel ALL running and blocked tasks for a device. Returns count cancelled. */
export function cancelAllTasksForDevice(deviceId: string): number {
  const running = getActiveTasksForDevice(deviceId);
  const blocked = getBlockedTasksForDevice(deviceId);
  for (const task of [...running, ...blocked]) {
    cancelTask(task.id);
  }
  return running.length + blocked.length;
}

/** Cancel all tasks for a device and return their original prompts for re-submission after restart. */
export function cancelAllTasksForRestart(deviceId: string): { cancelled: number; prompts: string[] } {
  const running = getActiveTasksForDevice(deviceId);
  const blocked = getBlockedTasksForDevice(deviceId);
  const allTasks = [...running, ...blocked];
  const prompts = allTasks
    .map(t => t.prompt)
    .filter(p => !!p);
  for (const task of allTasks) {
    cancelTask(task.id);
  }
  return { cancelled: allTasks.length, prompts };
}

/**
 * Check if a device has any active agent loops running.
 */
export function hasActiveTask(deviceId: string): boolean {
  return getActiveTasksForDevice(deviceId).length > 0;
}

/**
 * Get a count of active tasks for a device.
 */
export function activeTaskCount(deviceId: string): number {
  return getActiveTasksForDevice(deviceId).length;
}

// ============================================
// INTERNAL
// ============================================

/**
 * Mark a task as completed or failed.
 */
function completeTask(taskId: string, status: "completed" | "failed"): void {
  const task = tasks.get(taskId);
  if (!task) return;
  if (task.status === "cancelled") return;

  // Defensive: clear any dangling blocked state
  if (task.waitResolve || task.waitTimer) clearBlockedState(task);

  task.status = status;
  task.completedAt = Date.now();
  removeFromDeviceList(task.deviceId, taskId);

  const elapsed = task.completedAt - task.startedAt;
  log.info(`Agent task ${status}`, { taskId, name: task.name, deviceId: task.deviceId, elapsedMs: elapsed });

  // Clean up old tasks after a delay (keep for 5 min for debugging)
  setTimeout(() => {
    tasks.delete(taskId);
  }, 5 * 60 * 1000);
}

/**
 * Remove a task ID from its device's active list.
 */
function removeFromDeviceList(deviceId: string, taskId: string): void {
  const active = deviceActiveTasks.get(deviceId);
  if (!active) return;

  const idx = active.indexOf(taskId);
  if (idx !== -1) active.splice(idx, 1);

  if (active.length === 0) {
    deviceActiveTasks.delete(deviceId);
  }
}

// ============================================
// INJECTION ROUTING — STATUS QUERY DETECTION
// ============================================

/**
 * Detect if a message is a status query about running tasks.
 * These get a fast server-side response (elapsed time + recent activity)
 * without bothering the receptionist or the running agent.
 */
function isStatusQuery(message: string): boolean {
  const lower = message.trim().toLowerCase().replace(/[?!.]+$/, "").trim();
  const statusPatterns = [
    /^(any\s+)?(updates?|status|progress)$/,
    /^how('?s|\s+is)\s+(it|that|the\s+task|everything)\s*(going|coming|looking)?$/,
    /^what('?s|\s+is)\s+(the\s+)?(status|progress|update|eta)$/,
    /^(are\s+you\s+)?(still\s+)?(working|running|going|busy)$/,
    /^(you\s+)?(done|finished|complete)\s*(yet)?$/,
    /^where\s+are\s+(you|we)\s*(at)?$/,
    /^how\s+(far|much)\s+(along|left|done|more)$/,
    /^eta$/,
  ];
  return statusPatterns.some(p => p.test(lower));
}

// ============================================
// INJECTION ROUTING — LOCAL NAME MATCH
// ============================================

/**
 * Fast local match: check if the user's message references a task
 * by name, description, or persona. Case-insensitive substring.
 */
function matchTaskByName(activeTasks: AgentTask[], message: string): AgentTask | null {
  const msgLower = message.toLowerCase();

  // Score each task — higher = better match
  let bestTask: AgentTask | null = null;
  let bestScore = 0;

  for (const task of activeTasks) {
    let score = 0;

    // Exact task name mention (strongest signal)
    if (task.name && msgLower.includes(task.name.toLowerCase())) {
      score += 10;
    }

    // Persona name/id mention
    if (msgLower.includes(task.personaId.toLowerCase())) {
      score += 8;
    }

    // Check individual significant words from the task name (3+ chars)
    if (task.name) {
      const nameWords = task.name.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
      const matchedWords = nameWords.filter(w => msgLower.includes(w));
      if (matchedWords.length > 0) {
        score += matchedWords.length * 2;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestTask = task;
    }
  }

  // Require a minimum confidence — don't match on flimsy evidence
  return bestScore >= 4 ? bestTask : null;
}

