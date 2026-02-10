/**
 * Periodic Manager Tests
 * 
 * Covers:
 * - Lifecycle: start, stop, idempotent restart
 * - Activity tracking: notifyActivity resets idle clock
 * - Idle gating: tasks don't run when system is active
 * - Overlap prevention: only one task runs at a time
 * - Task scheduling: tasks run at configured intervals
 * - Gate function: canRun prevents execution when false
 * - Status queries: isAnyTaskRunning, isTaskRunning, getManagerStatus
 * - Error handling: task failures don't crash the manager
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  startPeriodicManager,
  stopPeriodicManager,
  notifyActivity,
  getIdleDurationMs,
  isAnyTaskRunning,
  isTaskRunning,
  getManagerStatus,
  _resetForTesting,
  type PeriodicTaskDef,
} from "./manager.js";

// ============================================
// SETUP
// ============================================

beforeEach(() => {
  vi.useFakeTimers();
  _resetForTesting();
});

afterEach(() => {
  stopPeriodicManager();
  vi.useRealTimers();
});

function makeTask(overrides: Partial<PeriodicTaskDef> = {}): PeriodicTaskDef {
  return {
    id: "test-task",
    name: "Test Task",
    intervalMs: 60_000,
    initialDelayMs: 0,
    enabled: true,
    run: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ============================================
// LIFECYCLE
// ============================================

describe("Periodic Manager Lifecycle", () => {
  it("starts and stops cleanly", () => {
    const task = makeTask();
    startPeriodicManager([task]);
    expect(getManagerStatus().running).toBe(true);

    stopPeriodicManager();
    expect(getManagerStatus().running).toBe(false);
  });

  it("is idempotent — calling start twice stops the first", () => {
    const task1 = makeTask({ id: "t1" });
    const task2 = makeTask({ id: "t2" });

    startPeriodicManager([task1]);
    startPeriodicManager([task2]);

    const status = getManagerStatus();
    expect(status.running).toBe(true);
    expect(status.tasks).toHaveLength(1);
    expect(status.tasks[0].id).toBe("t2");
  });

  it("stopPeriodicManager is safe to call multiple times", () => {
    stopPeriodicManager();
    stopPeriodicManager();
    expect(getManagerStatus().running).toBe(false);
  });

  it("reports tasks in status", () => {
    const tasks = [
      makeTask({ id: "heartbeat", name: "Heartbeat" }),
      makeTask({ id: "sleep", name: "Sleep Cycle", enabled: false }),
    ];
    startPeriodicManager(tasks);

    const status = getManagerStatus();
    expect(status.tasks).toHaveLength(2);
    expect(status.tasks[0].id).toBe("heartbeat");
    expect(status.tasks[1].enabled).toBe(false);
  });
});

// ============================================
// ACTIVITY TRACKING
// ============================================

describe("Activity Tracking", () => {
  it("notifyActivity resets idle clock", () => {
    startPeriodicManager([]);

    // Advance time to build up idle
    vi.advanceTimersByTime(60_000);
    const idleBefore = getIdleDurationMs();
    expect(idleBefore).toBeGreaterThanOrEqual(60_000);

    notifyActivity();
    const idleAfter = getIdleDurationMs();
    expect(idleAfter).toBeLessThan(1000);
  });

  it("getIdleDurationMs returns time since last activity", () => {
    startPeriodicManager([]);
    notifyActivity();
    vi.advanceTimersByTime(30_000);
    expect(getIdleDurationMs()).toBeGreaterThanOrEqual(30_000);
  });
});

// ============================================
// IDLE GATING
// ============================================

describe("Idle Gating", () => {
  it("does not run tasks when system is active (idle < 2min)", async () => {
    const task = makeTask({ intervalMs: 10_000, initialDelayMs: 0 });
    startPeriodicManager([task]);

    // Keep active by notifying every 30s
    for (let i = 0; i < 6; i++) {
      notifyActivity();
      await vi.advanceTimersByTimeAsync(30_000);
    }

    expect(task.run).not.toHaveBeenCalled();
  });

  it("runs tasks after idle threshold (2+ minutes)", async () => {
    const task = makeTask({ intervalMs: 10_000, initialDelayMs: 0 });
    startPeriodicManager([task]);

    // Let system go idle for 3 minutes (past 2-min threshold)
    // Poll fires every 15s, task due immediately (no lastRunAt)
    await vi.advanceTimersByTimeAsync(3 * 60_000);

    expect(task.run).toHaveBeenCalled();
  });
});

// ============================================
// OVERLAP PREVENTION
// ============================================

describe("Overlap Prevention", () => {
  it("only runs one task at a time", async () => {
    let resolveFirst!: () => void;
    const slowPromise = new Promise<void>(resolve => { resolveFirst = resolve; });

    const slowTask = makeTask({
      id: "slow",
      intervalMs: 10_000,
      run: vi.fn().mockReturnValue(slowPromise),
    });
    const fastTask = makeTask({
      id: "fast",
      intervalMs: 10_000,
      run: vi.fn().mockResolvedValue(undefined),
    });

    startPeriodicManager([slowTask, fastTask]);

    // Go idle + trigger poll
    await vi.advanceTimersByTimeAsync(3 * 60_000);

    // Slow task should be running
    expect(slowTask.run).toHaveBeenCalledTimes(1);
    expect(isAnyTaskRunning()).toBe(true);
    expect(isTaskRunning("slow")).toBe(true);

    // Fast task should NOT have run (overlap prevention)
    expect(fastTask.run).not.toHaveBeenCalled();

    // Resolve slow task
    resolveFirst();
    await vi.advanceTimersByTimeAsync(1);

    expect(isAnyTaskRunning()).toBe(false);
  });

  it("isAnyTaskRunning returns false when nothing is running", () => {
    startPeriodicManager([makeTask()]);
    expect(isAnyTaskRunning()).toBe(false);
  });
});

// ============================================
// GATE FUNCTION
// ============================================

describe("Gate Function (canRun)", () => {
  it("skips task when canRun returns false", async () => {
    const task = makeTask({
      intervalMs: 10_000,
      canRun: () => false,
    });
    startPeriodicManager([task]);

    await vi.advanceTimersByTimeAsync(3 * 60_000);

    expect(task.run).not.toHaveBeenCalled();
  });

  it("runs task when canRun returns true", async () => {
    const task = makeTask({
      intervalMs: 10_000,
      canRun: () => true,
    });
    startPeriodicManager([task]);

    await vi.advanceTimersByTimeAsync(3 * 60_000);

    expect(task.run).toHaveBeenCalled();
  });
});

// ============================================
// TASK SCHEDULING
// ============================================

describe("Task Scheduling", () => {
  it("respects task interval — does not re-run too soon", async () => {
    const task = makeTask({ intervalMs: 5 * 60_000 }); // 5 min interval
    startPeriodicManager([task]);

    // Go idle (3 min) — first run
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(task.run).toHaveBeenCalledTimes(1);

    // 2 more minutes — total 5 min since start, but only 2 min since last run
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(task.run).toHaveBeenCalledTimes(1); // Still 1

    // 3 more minutes — 5 min since last run
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(task.run).toHaveBeenCalledTimes(2); // Now 2
  });

  it("disabled tasks are never run", async () => {
    const task = makeTask({ enabled: false, intervalMs: 10_000 });
    startPeriodicManager([task]);

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(task.run).not.toHaveBeenCalled();
  });

  it("passes idle duration to run function", async () => {
    const task = makeTask({ intervalMs: 10_000 });
    startPeriodicManager([task]);

    // Go idle for 3 minutes
    await vi.advanceTimersByTimeAsync(3 * 60_000);

    expect(task.run).toHaveBeenCalled();
    const idleArg = (task.run as any).mock.calls[0][0];
    expect(idleArg).toBeGreaterThanOrEqual(2 * 60_000);
  });
});

// ============================================
// INITIAL DELAY
// ============================================

describe("Initial Delay", () => {
  it("runs task after initial delay if idle", async () => {
    const task = makeTask({
      intervalMs: 30 * 60_000, // 30 min interval
      initialDelayMs: 60_000,  // 1 min initial delay
    });
    startPeriodicManager([task]);

    // At 1 min: initial delay fires but only 60s idle (< 2min threshold)
    await vi.advanceTimersByTimeAsync(60_000);
    expect(task.run).not.toHaveBeenCalled();

    // At 3 min: system is idle for 3 min, poll should fire it
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(task.run).toHaveBeenCalledTimes(1);
  });
});

// ============================================
// ERROR HANDLING
// ============================================

describe("Error Handling", () => {
  it("task failure does not crash the manager", async () => {
    const task = makeTask({
      intervalMs: 10_000,
      run: vi.fn().mockRejectedValue(new Error("Task exploded")),
    });
    startPeriodicManager([task]);

    // Go idle — task will fail
    await vi.advanceTimersByTimeAsync(3 * 60_000);

    expect(task.run).toHaveBeenCalled();
    expect(getManagerStatus().running).toBe(true);
    expect(isAnyTaskRunning()).toBe(false);
  });

  it("task failure unblocks future runs", async () => {
    let callCount = 0;
    const task = makeTask({
      intervalMs: 15_000, // Short interval so second run triggers quickly
      run: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error("First run fails");
      }),
    });
    startPeriodicManager([task]);

    // First run — go idle 3 min, task fires and fails
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(callCount).toBeGreaterThanOrEqual(1);

    // Second run — advance another 30s (> 15s interval), still idle
    await vi.advanceTimersByTimeAsync(30_000);
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});

// ============================================
// STATUS
// ============================================

describe("Manager Status", () => {
  it("getManagerStatus returns full state", () => {
    const tasks = [
      makeTask({ id: "a", name: "Alpha", intervalMs: 5000, enabled: true }),
      makeTask({ id: "b", name: "Beta", intervalMs: 10000, enabled: false }),
    ];
    startPeriodicManager(tasks);

    const status = getManagerStatus();
    expect(status.running).toBe(true);
    expect(status.currentlyRunning).toBeNull();
    expect(status.tasks).toHaveLength(2);
    expect(status.tasks[0].id).toBe("a");
    expect(status.tasks[0].name).toBe("Alpha");
    expect(status.tasks[1].enabled).toBe(false);
  });

  it("status shows currentlyRunning during task execution", async () => {
    let resolveTask!: () => void;
    const blockingPromise = new Promise<void>(r => { resolveTask = r; });

    const task = makeTask({
      id: "blocking",
      intervalMs: 10_000,
      run: vi.fn().mockReturnValue(blockingPromise),
    });
    startPeriodicManager([task]);

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(getManagerStatus().currentlyRunning).toBe("blocking");

    resolveTask();
    await vi.advanceTimersByTimeAsync(1);
    expect(getManagerStatus().currentlyRunning).toBeNull();
  });

  it("status.idleMs reflects time since last activity", () => {
    startPeriodicManager([]);
    notifyActivity();
    vi.advanceTimersByTime(45_000);
    const status = getManagerStatus();
    expect(status.idleMs).toBeGreaterThanOrEqual(45_000);
  });
});

// ============================================
// RECONNECTION / IDEMPOTENCY
// ============================================

describe("Reconnection Idempotency", () => {
  it("calling startPeriodicManager again resets state cleanly", async () => {
    const task1 = makeTask({ id: "v1", intervalMs: 10_000 });
    startPeriodicManager([task1]);

    // Go idle, first task runs
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(task1.run).toHaveBeenCalled();

    // Simulate reconnection — new tasks
    const task2 = makeTask({ id: "v2", intervalMs: 10_000 });
    startPeriodicManager([task2]);

    const status = getManagerStatus();
    expect(status.tasks).toHaveLength(1);
    expect(status.tasks[0].id).toBe("v2");

    // v2 should run after idle
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(task2.run).toHaveBeenCalled();
  });

  it("old tasks don't fire after restart", async () => {
    const oldTask = makeTask({ id: "old", intervalMs: 10_000 });
    startPeriodicManager([oldTask]);

    // Restart with new tasks before old task gets a chance
    const newTask = makeTask({ id: "new", intervalMs: 10_000 });
    startPeriodicManager([newTask]);

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(oldTask.run).not.toHaveBeenCalled();
    expect(newTask.run).toHaveBeenCalled();
  });
});

// ============================================
// PRIORITY ORDERING
// ============================================

describe("Priority Ordering", () => {
  it("first due task in registration order wins", async () => {
    const callOrder: string[] = [];
    const taskA = makeTask({
      id: "a",
      intervalMs: 5 * 60_000, // 5 min — won't be due again for a while
      run: vi.fn().mockImplementation(async () => { callOrder.push("a"); }),
    });
    const taskB = makeTask({
      id: "b",
      intervalMs: 5 * 60_000,
      run: vi.fn().mockImplementation(async () => { callOrder.push("b"); }),
    });
    startPeriodicManager([taskA, taskB]);

    // First poll — A runs first (registration order), B blocked (overlap)
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(callOrder[0]).toBe("a");

    // Next poll — A's interval hasn't elapsed (ran <30s ago), B is due (never ran)
    await vi.advanceTimersByTimeAsync(30_000);
    expect(callOrder).toContain("b");
  });
});

// ============================================
// ACTIVITY DURING EXECUTION
// ============================================

describe("Activity During Task Execution", () => {
  it("notifyActivity during a running task does not cancel it", async () => {
    let resolveTask!: () => void;
    const blockingPromise = new Promise<void>(r => { resolveTask = r; });

    const task = makeTask({
      id: "long",
      intervalMs: 10_000,
      run: vi.fn().mockReturnValue(blockingPromise),
    });
    startPeriodicManager([task]);

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(isAnyTaskRunning()).toBe(true);

    // User activity during execution
    notifyActivity();

    // Task should still be running
    expect(isAnyTaskRunning()).toBe(true);

    resolveTask();
    await vi.advanceTimersByTimeAsync(1);
    expect(isAnyTaskRunning()).toBe(false);
  });
});

// ============================================
// EDGE CASES
// ============================================

describe("Edge Cases", () => {
  it("notifyActivity is safe to call before manager starts", () => {
    // Should not throw
    notifyActivity();
    expect(getIdleDurationMs()).toBeLessThan(1000);
  });

  it("getManagerStatus works when manager is not running", () => {
    const status = getManagerStatus();
    expect(status.running).toBe(false);
    expect(status.tasks).toHaveLength(0);
  });

  it("isAnyTaskRunning is false when manager is not running", () => {
    expect(isAnyTaskRunning()).toBe(false);
  });

  it("isTaskRunning returns false for non-existent task", () => {
    startPeriodicManager([makeTask()]);
    expect(isTaskRunning("non-existent")).toBe(false);
  });

  it("empty task list starts without error", () => {
    startPeriodicManager([]);
    expect(getManagerStatus().running).toBe(true);
    expect(getManagerStatus().tasks).toHaveLength(0);
  });
});
