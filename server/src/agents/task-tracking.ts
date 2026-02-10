/**
 * Task Tracking & Thread Persistence
 * 
 * Standalone functions for managing persistent tasks and saving
 * conversation turns to threads. Extracted from AgentRunner to
 * keep the runner focused on orchestration.
 */

import { createComponentLogger } from "../logging.js";
import { startTaskTimer, clearTaskTimer, getTimeEstimate } from "./task-monitor.js";
import type { AgentRunnerOptions } from "./runner-types.js";
import type { ReceptionistDecision } from "../types/agent.js";

const log = createComponentLogger("task-tracking");

// ============================================
// TASK LIFECYCLE
// ============================================

/**
 * Create a tracked task for an actionable request.
 * Returns the task ID or undefined if tracking isn't wired.
 */
export async function createTrackedTask(
  options: AgentRunnerOptions,
  decision: ReceptionistDecision,
  threadId: string | null,
  originPrompt: string
): Promise<string | undefined> {
  if (!options.onCreateTask) return undefined;

  try {
    const priority = decision.priority === "BLOCKING" ? "high"
      : decision.priority === "BACKGROUND" ? "low" : "medium";

    const result = await options.onCreateTask({
      description: decision.formattedRequest || originPrompt.substring(0, 200),
      priority,
      threadId: threadId || undefined,
      personaId: decision.personaId || undefined,
      originPrompt,
    });

    const taskId = result?.id;
    if (taskId) {
      log.info("Task created", { taskId, description: (decision.formattedRequest || originPrompt).substring(0, 60) });

      // Start per-task timer based on classification estimate
      if (options.onTaskProgress) {
        const estimateMs = getTimeEstimate(decision.classification);
        startTaskTimer(taskId, estimateMs, options.onTaskProgress);
      }
    }
    return taskId;
  } catch (err) {
    log.warn("Failed to create tracked task", { error: err });
    return undefined;
  }
}

/**
 * Mark a tracked task as completed (fire-and-forget).
 */
export function completeTrackedTask(
  options: AgentRunnerOptions,
  taskId: string | undefined,
  response: string
): void {
  if (!taskId || !options.onUpdateTask) return;

  clearTaskTimer(taskId);

  setImmediate(async () => {
    try {
      await options.onUpdateTask!(taskId, {
        status: "completed",
        lastResponse: response.substring(0, 500),
      });
    } catch (err) {
      log.warn("Failed to complete tracked task", { taskId, error: err });
    }
  });
}

/**
 * Resume an existing tracked task — mark it back as in_progress (fire-and-forget).
 */
export function resumeTrackedTask(
  options: AgentRunnerOptions,
  taskId: string | undefined
): void {
  if (!taskId || !options.onUpdateTask) return;

  // Restart timer for resumed tasks
  if (options.onTaskProgress) {
    startTaskTimer(taskId, getTimeEstimate("CONTINUATION"), options.onTaskProgress);
  }

  setImmediate(async () => {
    try {
      await options.onUpdateTask!(taskId, {
        status: "in_progress",
      });
    } catch (err) {
      log.warn("Failed to resume tracked task", { taskId, error: err });
    }
  });
}

/**
 * Mark a tracked task as failed (fire-and-forget).
 */
export function failTrackedTask(
  options: AgentRunnerOptions,
  taskId: string | undefined,
  error: string
): void {
  if (!taskId || !options.onUpdateTask) return;

  clearTaskTimer(taskId);

  setImmediate(async () => {
    try {
      await options.onUpdateTask!(taskId, {
        status: "failed",
        lastError: error,
      });
    } catch (err) {
      log.warn("Failed to mark task as failed", { taskId, error: err });
    }
  });
}

// ============================================
// THREAD PERSISTENCE
// ============================================

/**
 * Save user prompt and assistant response to a thread (fire-and-forget).
 */
export function persistToThread(
  options: AgentRunnerOptions,
  threadId: string,
  topic: string,
  userPrompt: string,
  assistantResponse: string
): void {
  if (!options.onSaveToThread) return;

  // Fire-and-forget — don't block the response
  setImmediate(async () => {
    try {
      await options.onSaveToThread!(threadId, {
        role: "user",
        content: userPrompt,
        topic,
      });
      await options.onSaveToThread!(threadId, {
        role: "assistant",
        content: assistantResponse,
        topic,
      });
      log.info("Saved to thread", { threadId, topic: topic.substring(0, 50) });
    } catch (err) {
      log.error("Failed to save to thread", { threadId, error: err });
    }
  });
}
