/**
 * Agent Tasks — Cancellation & Lifecycle Tests
 * 
 * Covers:
 * - spawnTask creates a running task
 * - cancelTask sets status to cancelled and fires abort
 * - completeTask (internal) does NOT overwrite cancelled status
 * - getTaskById finds cancelled tasks (for ghost message suppression)
 * - cancelAllTasksForDevice cancels all active tasks
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  spawnTask,
  cancelTask,
  cancelAllTasksForDevice,
  cancelAllTasksForRestart,
  getTaskById,
  hasActiveTask,
  activeTaskCount,
  getActiveTasksForDevice,
  routeInjection,
  injectMessageToTask,
  setWatchdogLLM,
} from "./agent-tasks.js";

// Provide a no-op LLM so the watchdog doesn't crash
setWatchdogLLM({
  chat: vi.fn().mockResolvedValue("ok"),
  stream: vi.fn(),
} as any);

// Track spawned task IDs so we can clean up
const spawnedTaskIds: string[] = [];

afterEach(() => {
  // Cancel any leftover tasks
  for (const id of spawnedTaskIds) {
    try { cancelTask(id); } catch {}
  }
  spawnedTaskIds.length = 0;
});

function spawnTestTask(
  deviceId: string,
  runFn?: (q: string[], tid: string, signal: AbortSignal) => Promise<any>,
) {
  const defaultRunFn = runFn || ((_q, _tid, _signal) =>
    new Promise((resolve) => setTimeout(() => resolve({
      success: true,
      response: "done",
      classification: "ACTION",
      threadIds: [],
      keyPoints: [],
    }), 50))
  );

  const task = spawnTask(
    deviceId,
    "user_test",
    "test prompt",
    "test-persona",
    "Test Task",
    "Test task description",
    defaultRunFn,
  );

  spawnedTaskIds.push(task.id);
  return task;
}

// ============================================
// SPAWN & LIFECYCLE
// ============================================

describe("spawnTask", () => {
  it("creates a running task with correct properties", () => {
    const task = spawnTestTask("dev_1");
    expect(task.status).toBe("running");
    expect(task.deviceId).toBe("dev_1");
    expect(task.userId).toBe("user_test");
    expect(task.personaId).toBe("test-persona");
    expect(task.name).toBe("Test Task");
    expect(task.prompt).toBe("test prompt");
    expect(task.injectionQueue).toEqual([]);
  });

  it("is visible via hasActiveTask", () => {
    const task = spawnTestTask("dev_active");
    expect(hasActiveTask("dev_active")).toBe(true);
    expect(activeTaskCount("dev_active")).toBe(1);
    cancelTask(task.id);
  });

  it("is findable via getTaskById", () => {
    const task = spawnTestTask("dev_find");
    const found = getTaskById(task.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(task.id);
    cancelTask(task.id);
  });
});

// ============================================
// CANCELLATION
// ============================================

describe("cancelTask", () => {
  it("sets status to cancelled", () => {
    const task = spawnTestTask("dev_cancel");
    expect(task.status).toBe("running");

    cancelTask(task.id);

    expect(task.status).toBe("cancelled");
  });

  it("fires the abort signal", () => {
    const task = spawnTestTask("dev_abort");
    expect(task.abortController.signal.aborted).toBe(false);

    cancelTask(task.id);

    expect(task.abortController.signal.aborted).toBe(true);
  });

  it("removes task from active list", () => {
    const task = spawnTestTask("dev_remove");
    expect(hasActiveTask("dev_remove")).toBe(true);

    cancelTask(task.id);

    expect(hasActiveTask("dev_remove")).toBe(false);
  });

  it("task remains findable via getTaskById after cancellation", () => {
    const task = spawnTestTask("dev_findable");
    cancelTask(task.id);

    const found = getTaskById(task.id);
    expect(found).toBeDefined();
    expect(found!.status).toBe("cancelled");
  });
});

describe("cancelAllTasksForDevice", () => {
  it("cancels all active tasks and returns count", () => {
    const t1 = spawnTestTask("dev_all");
    const t2 = spawnTestTask("dev_all");

    expect(activeTaskCount("dev_all")).toBe(2);

    const cancelled = cancelAllTasksForDevice("dev_all");

    expect(cancelled).toBe(2);
    expect(t1.status).toBe("cancelled");
    expect(t2.status).toBe("cancelled");
    expect(hasActiveTask("dev_all")).toBe(false);
  });

  it("returns 0 for device with no tasks", () => {
    expect(cancelAllTasksForDevice("dev_none")).toBe(0);
  });
});

// ============================================
// CANCELLED STATUS PRESERVATION
// ============================================

// ============================================
// INJECTION ROUTING
// ============================================

describe("routeInjection", () => {
  it("returns none when no tasks are active", async () => {
    const result = await routeInjection("dev_no_tasks", "hello");
    expect(result.task).toBeNull();
    expect(result.method).toBe("none");
  });

  it("injects into single active task", async () => {
    const task = spawnTestTask("dev_single_inject");
    const result = await routeInjection("dev_single_inject", "I have a discord account");
    expect(result.task).toBeDefined();
    expect(result.task!.id).toBe(task.id);
    expect(result.method).toBe("single_task");
    cancelTask(task.id);
  });

  it("routes status queries separately", async () => {
    const task = spawnTestTask("dev_status_q");
    const result = await routeInjection("dev_status_q", "what's the status?");
    expect(result.method).toBe("status_query");
    cancelTask(task.id);
  });

  it("falls back to most recent task when multiple active", async () => {
    const t1 = spawnTestTask("dev_multi_inject");
    // Small delay so t2 is more recent
    await new Promise(r => setTimeout(r, 5));
    const t2 = spawnTestTask("dev_multi_inject");
    const result = await routeInjection("dev_multi_inject", "some update");
    expect(result.task).toBeDefined();
    expect(result.task!.id).toBe(t2.id);
    expect(result.method).toBe("most_recent");
    cancelTask(t1.id);
    cancelTask(t2.id);
  });

  it("injectMessageToTask pushes to injection queue", () => {
    const task = spawnTestTask("dev_inject_msg");
    expect(task.injectionQueue).toEqual([]);
    const ok = injectMessageToTask(task.id, "user correction");
    expect(ok).toBe(true);
    expect(task.injectionQueue).toEqual(["user correction"]);
    cancelTask(task.id);
  });
});

// ============================================
// CANCELLED STATUS PRESERVATION
// ============================================

describe("completeTask does not overwrite cancelled status", () => {
  it("cancelled task stays cancelled after promise resolves", async () => {
    let resolveTask!: (val: any) => void;
    const taskPromise = new Promise((resolve) => { resolveTask = resolve; });

    const task = spawnTestTask("dev_preserve", (_q, _tid, _signal) => taskPromise as any);
    
    // Cancel before the run function resolves
    cancelTask(task.id);
    expect(task.status).toBe("cancelled");

    // Now resolve the run function — internal completeTask should NOT overwrite
    resolveTask({
      success: true,
      response: "late result",
      classification: "ACTION",
      threadIds: [],
      keyPoints: [],
    });

    // Wait for promise chain to settle
    await new Promise(r => setTimeout(r, 20));

    // Status must still be cancelled
    expect(task.status).toBe("cancelled");
  });

  it("cancelled task stays cancelled after promise rejects", async () => {
    let rejectTask!: (err: Error) => void;
    const taskPromise = new Promise((_resolve, reject) => { rejectTask = reject; });

    const task = spawnTestTask("dev_reject", (_q, _tid, _signal) => taskPromise as any);

    // Suppress the unhandled rejection from spawnTask's internal re-throw
    task.promise.catch(() => {});
    
    cancelTask(task.id);
    expect(task.status).toBe("cancelled");

    // Reject the run function
    rejectTask(new Error("Operation aborted"));

    await new Promise(r => setTimeout(r, 20));

    expect(task.status).toBe("cancelled");
  });
});

// ============================================
// CANCEL FOR RESTART (returns prompts)
// ============================================

describe("cancelAllTasksForRestart", () => {
  it("cancels all tasks and returns their original prompts", () => {
    const t1 = spawnTestTask("dev_restart");
    const t2 = spawnTestTask("dev_restart");

    const result = cancelAllTasksForRestart("dev_restart");

    expect(result.cancelled).toBe(2);
    expect(result.prompts).toHaveLength(2);
    expect(result.prompts).toContain("test prompt");
    expect(t1.status).toBe("cancelled");
    expect(t2.status).toBe("cancelled");
    expect(hasActiveTask("dev_restart")).toBe(false);
  });

  it("returns empty prompts for device with no tasks", () => {
    const result = cancelAllTasksForRestart("dev_no_restart");
    expect(result.cancelled).toBe(0);
    expect(result.prompts).toEqual([]);
  });

  it("returns prompts with different values per task", () => {
    // Spawn with custom prompts
    const t1 = spawnTask(
      "dev_mixed_restart", "user_test", "find the image",
      "general", "Task A", "desc",
      () => new Promise(r => setTimeout(() => r({ success: true, response: "done", classification: "ACTION", threadIds: [], keyPoints: [] }), 50)),
    );
    spawnedTaskIds.push(t1.id);

    const t2 = spawnTask(
      "dev_mixed_restart", "user_test", "send to discord",
      "sysadmin", "Task B", "desc",
      () => new Promise(r => setTimeout(() => r({ success: true, response: "done", classification: "ACTION", threadIds: [], keyPoints: [] }), 50)),
    );
    spawnedTaskIds.push(t2.id);

    const result = cancelAllTasksForRestart("dev_mixed_restart");

    expect(result.cancelled).toBe(2);
    expect(result.prompts).toContain("find the image");
    expect(result.prompts).toContain("send to discord");
  });
});
