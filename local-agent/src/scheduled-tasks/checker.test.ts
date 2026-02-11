/**
 * Scheduled Task Checker Tests
 *
 * Covers:
 * - Initialization: wsSend wiring, stale state clearing on reconnect
 * - canCheckScheduledTasks: gate predicate
 * - checkScheduledTasks: due task submission, missed task callback, concurrency limit, dedup guard
 * - handleScheduledTaskResponse: two-phase matching (inline, routing ack, agent_complete)
 * - Routing ack without agentTaskId guard
 * - Timeout cleanup: prompt phase and execution phase
 * - Callbacks: result, error, missed
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the store module
vi.mock("./store.js", () => ({
  getDueAndMissedTasks: vi.fn(),
  getScheduledTask: vi.fn(),
  markTaskRun: vi.fn(),
  markTaskFailed: vi.fn(),
  advanceMissedTask: vi.fn(),
}));

// Mock nanoid to return incrementing values (unique Map keys)
let nanoidCounter = 0;
vi.mock("nanoid", () => ({
  nanoid: vi.fn(() => `id${++nanoidCounter}`),
}));

import {
  initScheduledTaskChecker,
  canCheckScheduledTasks,
  checkScheduledTasks,
  handleScheduledTaskResponse,
  setScheduledTaskResultCallback,
  setScheduledTaskErrorCallback,
  setScheduledTaskMissedCallback,
} from "./checker.js";
import {
  getDueAndMissedTasks,
  getScheduledTask,
  markTaskRun,
  markTaskFailed,
  advanceMissedTask,
} from "./store.js";
import type { ScheduledTask, DueTask } from "./store.js";
import type { WSMessage } from "../types.js";

const mockGetDue = vi.mocked(getDueAndMissedTasks);
const mockGetTask = vi.mocked(getScheduledTask);
const mockMarkRun = vi.mocked(markTaskRun);
const mockMarkFailed = vi.mocked(markTaskFailed);
const mockAdvanceMissed = vi.mocked(advanceMissedTask);

// ============================================
// HELPERS
// ============================================

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "sched_test123",
    name: "Test Task",
    prompt: "Do the thing",
    schedule: { type: "daily", time: "06:00" },
    priority: "P2",
    status: "active",
    nextRunAt: "2026-02-10T06:00:00.000Z",
    consecutiveFailures: 0,
    maxFailures: 3,
    createdAt: "2026-02-10T00:00:00.000Z",
    ...overrides,
  };
}

let mockSend: ReturnType<typeof vi.fn>;
let sentMessages: WSMessage[];

function setupSend(): void {
  sentMessages = [];
  mockSend = vi.fn((msg: WSMessage) => sentMessages.push(msg));
  initScheduledTaskChecker(mockSend);
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockGetDue.mockResolvedValue([]);
  mockGetTask.mockResolvedValue(null);
  mockMarkRun.mockResolvedValue(undefined);
  mockMarkFailed.mockResolvedValue(false);
  mockAdvanceMissed.mockResolvedValue(undefined);
  sentMessages = [];
  mockSend = vi.fn();
  nanoidCounter = 0;
  // Start fresh — no wsSend
  initScheduledTaskChecker(null as any);
});

// ============================================
// INITIALIZATION
// ============================================

describe("initScheduledTaskChecker", () => {
  it("enables canCheckScheduledTasks after init", () => {
    expect(canCheckScheduledTasks()).toBe(false);
    setupSend();
    expect(canCheckScheduledTasks()).toBe(true);
  });

  it("clears stale state on reconnect", async () => {
    setupSend();

    // Submit a task to populate pending state
    const task = makeTask();
    mockGetDue.mockResolvedValue([{ task, type: "due" }]);
    await checkScheduledTasks();
    expect(sentMessages).toHaveLength(1);

    // Re-init (simulates reconnect) — clears pending
    setupSend();

    // The previously pending task should not be tracked
    // Submit same task again — should work (not blocked by dedup)
    mockGetDue.mockResolvedValue([{ task, type: "due" }]);
    await checkScheduledTasks();
    expect(sentMessages).toHaveLength(1);
  });
});

// ============================================
// canCheckScheduledTasks
// ============================================

describe("canCheckScheduledTasks", () => {
  it("returns false when wsSend is not set", () => {
    expect(canCheckScheduledTasks()).toBe(false);
  });

  it("returns true when wsSend is set", () => {
    setupSend();
    expect(canCheckScheduledTasks()).toBe(true);
  });
});

// ============================================
// checkScheduledTasks — due task submission
// ============================================

describe("checkScheduledTasks — due tasks", () => {
  it("submits a due task as a prompt to the server", async () => {
    setupSend();
    const task = makeTask({ personaHint: "researcher" });
    mockGetDue.mockResolvedValue([{ task, type: "due" }]);

    await checkScheduledTasks();

    expect(sentMessages).toHaveLength(1);
    const msg = sentMessages[0];
    expect(msg.type).toBe("prompt");
    expect(msg.id).toMatch(/^sched_/);
    expect(msg.payload.prompt).toBe("Do the thing");
    expect(msg.payload.source).toBe("scheduled_task");
    expect(msg.payload.scheduledTaskId).toBe(task.id);
    expect(msg.payload.hints?.personaHint).toBe("researcher");
  });

  it("does nothing when no tasks are due", async () => {
    setupSend();
    mockGetDue.mockResolvedValue([]);

    await checkScheduledTasks();
    expect(sentMessages).toHaveLength(0);
  });

  it("does nothing when WS is not connected", async () => {
    // Don't call setupSend — wsSend is null
    mockGetDue.mockResolvedValue([{ task: makeTask(), type: "due" }]);
    await checkScheduledTasks();
    expect(mockGetDue).not.toHaveBeenCalled();
  });

  it("respects MAX_CONCURRENT limit", async () => {
    setupSend();
    const tasks = [
      makeTask({ id: "sched_a", name: "Task A" }),
      makeTask({ id: "sched_b", name: "Task B" }),
      makeTask({ id: "sched_c", name: "Task C" }),
    ];
    mockGetDue.mockResolvedValue(tasks.map(t => ({ task: t, type: "due" as const })));

    await checkScheduledTasks();
    // MAX_CONCURRENT is 2, so only 2 should be sent
    expect(sentMessages).toHaveLength(2);
  });

  it("does not re-submit a task that is already in-flight", async () => {
    setupSend();
    const task = makeTask();
    mockGetDue.mockResolvedValue([{ task, type: "due" }]);

    // First check — submits the task
    await checkScheduledTasks();
    expect(sentMessages).toHaveLength(1);

    // Second check — same task still in-flight, should skip
    await checkScheduledTasks();
    expect(sentMessages).toHaveLength(1); // no new message
  });
});

// ============================================
// checkScheduledTasks — missed tasks
// ============================================

describe("checkScheduledTasks — missed tasks", () => {
  it("calls missed callback and advances nextRunAt", async () => {
    setupSend();
    const task = makeTask({ id: "sched_missed" });
    mockGetDue.mockResolvedValue([{ task, type: "missed" }]);

    const missedCb = vi.fn();
    setScheduledTaskMissedCallback(missedCb);

    await checkScheduledTasks();

    expect(missedCb).toHaveBeenCalledWith(task);
    expect(mockAdvanceMissed).toHaveBeenCalledWith("sched_missed");
    expect(sentMessages).toHaveLength(0); // missed tasks are NOT submitted
  });
});

// ============================================
// handleScheduledTaskResponse — inline (fast path)
// ============================================

describe("handleScheduledTaskResponse — inline response", () => {
  it("matches inline response by prompt ID and calls result callback", async () => {
    setupSend();
    const task = makeTask({ id: "sched_inline" });
    mockGetDue.mockResolvedValue([{ task, type: "due" }]);
    mockGetTask.mockResolvedValue(task);
    mockMarkRun.mockResolvedValue(undefined);

    const resultCb = vi.fn();
    setScheduledTaskResultCallback(resultCb);

    await checkScheduledTasks();
    const promptId = sentMessages[0].id;

    // Simulate server sending an inline response
    const handled = handleScheduledTaskResponse({
      type: "response",
      id: promptId,
      timestamp: Date.now(),
      payload: { response: "Here are the news results..." },
    });

    expect(handled).toBe(true);

    // Allow async completeTask to finish
    await vi.waitFor(() => {
      expect(mockMarkRun).toHaveBeenCalledWith("sched_inline", "Here are the news results...");
    });
    await vi.waitFor(() => {
      expect(resultCb).toHaveBeenCalledWith(task, "Here are the news results...");
    });
  });

  it("returns false for unrelated response messages", () => {
    setupSend();
    const handled = handleScheduledTaskResponse({
      type: "response",
      id: "some_other_id",
      timestamp: Date.now(),
      payload: { response: "Something" },
    });
    expect(handled).toBe(false);
  });
});

// ============================================
// handleScheduledTaskResponse — two-phase (background path)
// ============================================

describe("handleScheduledTaskResponse — routing ack + agent_complete", () => {
  it("transitions to Phase 2 on routing ack, then matches agent_complete", async () => {
    setupSend();
    const task = makeTask({ id: "sched_bg" });
    mockGetDue.mockResolvedValue([{ task, type: "due" }]);
    mockGetTask.mockResolvedValue(task);

    const resultCb = vi.fn();
    setScheduledTaskResultCallback(resultCb);

    await checkScheduledTasks();
    const promptId = sentMessages[0].id;

    // Phase 1→2: Routing ack with agentTaskId
    const ackHandled = handleScheduledTaskResponse({
      type: "response",
      id: promptId,
      timestamp: Date.now(),
      payload: {
        response: "On it — I've assigned researcher...",
        isRoutingAck: true,
        agentTaskId: "task_server_123",
      },
    });
    // Returns false — ack passes through to normal routing
    expect(ackHandled).toBe(false);

    // Phase 2: agent_complete matched by server task ID
    const completeHandled = handleScheduledTaskResponse({
      type: "agent_complete",
      id: "some_new_id",
      timestamp: Date.now(),
      payload: {
        taskId: "task_server_123",
        success: true,
        response: "Here are the results",
      },
    });
    expect(completeHandled).toBe(true);

    await vi.waitFor(() => {
      expect(mockMarkRun).toHaveBeenCalledWith("sched_bg", "Here are the results");
    });
  });

  it("handles failed agent_complete", async () => {
    setupSend();
    const task = makeTask({ id: "sched_fail" });
    mockGetDue.mockResolvedValue([{ task, type: "due" }]);
    mockGetTask.mockResolvedValue(task);
    mockMarkFailed.mockResolvedValue(false);

    const errorCb = vi.fn();
    setScheduledTaskErrorCallback(errorCb);

    await checkScheduledTasks();
    const promptId = sentMessages[0].id;

    // Transition to Phase 2
    handleScheduledTaskResponse({
      type: "response",
      id: promptId,
      timestamp: Date.now(),
      payload: { isRoutingAck: true, agentTaskId: "task_fail_1" },
    });

    // Failed completion
    handleScheduledTaskResponse({
      type: "agent_complete",
      id: "x",
      timestamp: Date.now(),
      payload: { taskId: "task_fail_1", success: false, response: "Agent error" },
    });

    await vi.waitFor(() => {
      expect(mockMarkFailed).toHaveBeenCalledWith("sched_fail", "Agent error");
    });
  });

  it("returns false for unrelated agent_complete", () => {
    setupSend();
    const handled = handleScheduledTaskResponse({
      type: "agent_complete",
      id: "x",
      timestamp: Date.now(),
      payload: { taskId: "task_unknown", success: true, response: "result" },
    });
    expect(handled).toBe(false);
  });
});

// ============================================
// Routing ack without agentTaskId guard
// ============================================

describe("handleScheduledTaskResponse — routing ack without agentTaskId", () => {
  it("does NOT treat routing ack as inline result", async () => {
    setupSend();
    const task = makeTask();
    mockGetDue.mockResolvedValue([{ task, type: "due" }]);

    await checkScheduledTasks();
    const promptId = sentMessages[0].id;

    // Routing ack without agentTaskId (shouldn't happen, but defensively)
    const handled = handleScheduledTaskResponse({
      type: "response",
      id: promptId,
      timestamp: Date.now(),
      payload: {
        response: "On it — I've assigned researcher...",
        isRoutingAck: true,
        // NO agentTaskId
      },
    });

    // Should NOT be treated as inline result
    expect(handled).toBe(false);
    // Should NOT have called markTaskRun with ack text
    expect(mockMarkRun).not.toHaveBeenCalled();
  });
});

// ============================================
// Timeout cleanup
// ============================================

describe("timeout cleanup", () => {
  it("times out tasks stuck in prompt phase", async () => {
    setupSend();
    const task = makeTask({ id: "sched_timeout" });
    mockGetDue.mockResolvedValueOnce([{ task, type: "due" }]);
    mockGetTask.mockResolvedValue(task);
    mockMarkFailed.mockResolvedValue(false);

    const errorCb = vi.fn();
    setScheduledTaskErrorCallback(errorCb);

    await checkScheduledTasks();
    expect(sentMessages).toHaveLength(1);

    // Advance time past TASK_TIMEOUT_MS (5 minutes)
    const originalNow = Date.now;
    Date.now = () => originalNow() + 6 * 60 * 1000;

    // Next check should clean up the timed-out task
    mockGetDue.mockResolvedValueOnce([]);
    await checkScheduledTasks();

    await vi.waitFor(() => {
      expect(mockMarkFailed).toHaveBeenCalledWith("sched_timeout", "Execution timed out");
    });

    Date.now = originalNow;
  });

  it("times out tasks stuck in execution phase (after routing ack)", async () => {
    setupSend();
    const task = makeTask({ id: "sched_exec_timeout" });
    mockGetDue.mockResolvedValueOnce([{ task, type: "due" }]);
    mockGetTask.mockResolvedValue(task);
    mockMarkFailed.mockResolvedValue(true); // will cause pause

    const errorCb = vi.fn();
    setScheduledTaskErrorCallback(errorCb);

    await checkScheduledTasks();
    const promptId = sentMessages[0].id;

    // Transition to Phase 2
    handleScheduledTaskResponse({
      type: "response",
      id: promptId,
      timestamp: Date.now(),
      payload: { isRoutingAck: true, agentTaskId: "task_slow" },
    });

    // Advance time past TASK_TIMEOUT_MS
    const originalNow = Date.now;
    Date.now = () => originalNow() + 6 * 60 * 1000;

    mockGetDue.mockResolvedValueOnce([]);
    await checkScheduledTasks();

    await vi.waitFor(() => {
      expect(mockMarkFailed).toHaveBeenCalledWith("sched_exec_timeout", "Execution timed out");
    });

    Date.now = originalNow;
  });

  it("timed-out task can be re-submitted on next cycle", async () => {
    setupSend();
    const task = makeTask({ id: "sched_retry" });
    mockGetDue.mockResolvedValue([{ task, type: "due" }]);
    mockGetTask.mockResolvedValue(task);
    mockMarkFailed.mockResolvedValue(false);

    await checkScheduledTasks();
    expect(sentMessages).toHaveLength(1);

    // Advance time past timeout
    const originalNow = Date.now;
    Date.now = () => originalNow() + 6 * 60 * 1000;

    // Cleanup + re-submit
    await checkScheduledTasks();

    // Should have sent 2 messages total (original + retry)
    expect(sentMessages).toHaveLength(2);

    Date.now = originalNow;
  });
});

// ============================================
// Error handling
// ============================================

describe("error handling", () => {
  it("handles getDueAndMissedTasks failure gracefully", async () => {
    setupSend();
    mockGetDue.mockRejectedValue(new Error("Disk read error"));

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await checkScheduledTasks();
    expect(consoleSpy).toHaveBeenCalled();
    expect(sentMessages).toHaveLength(0);
    consoleSpy.mockRestore();
  });

  it("handles markTaskRun failure gracefully (result still delivered)", async () => {
    setupSend();
    const task = makeTask({ id: "sched_write_fail" });
    mockGetDue.mockResolvedValue([{ task, type: "due" }]);
    mockGetTask.mockResolvedValue(task);
    mockMarkRun.mockRejectedValue(new Error("Write failed"));

    const resultCb = vi.fn();
    setScheduledTaskResultCallback(resultCb);

    await checkScheduledTasks();
    const promptId = sentMessages[0].id;

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    handleScheduledTaskResponse({
      type: "response",
      id: promptId,
      timestamp: Date.now(),
      payload: { response: "Result text" },
    });

    // Callback still fires even though markTaskRun failed
    await vi.waitFor(() => {
      expect(resultCb).toHaveBeenCalledWith(task, "Result text");
    });

    consoleSpy.mockRestore();
  });
});

// ============================================
// Server error handling
// ============================================

describe("handleScheduledTaskResponse — server errors", () => {
  it("fails task immediately on matching error message", async () => {
    setupSend();
    const task = makeTask({ id: "sched_err" });
    mockGetDue.mockResolvedValue([{ task, type: "due" }]);
    mockGetTask.mockResolvedValue(task);
    mockMarkFailed.mockResolvedValue(false);

    const errorCb = vi.fn();
    setScheduledTaskErrorCallback(errorCb);

    await checkScheduledTasks();
    const promptId = sentMessages[0].id;

    const handled = handleScheduledTaskResponse({
      type: "error" as any,
      id: promptId,
      timestamp: Date.now(),
      payload: { error: "Auth expired" },
    });

    expect(handled).toBe(true);

    await vi.waitFor(() => {
      expect(mockMarkFailed).toHaveBeenCalledWith("sched_err", "Auth expired");
    });
  });

  it("clears inFlightTaskIds so task can be re-submitted", async () => {
    setupSend();
    const task = makeTask({ id: "sched_retry_err" });
    mockGetDue.mockResolvedValue([{ task, type: "due" }]);
    mockGetTask.mockResolvedValue(task);
    mockMarkFailed.mockResolvedValue(false);

    await checkScheduledTasks();
    const promptId = sentMessages[0].id;

    // Server rejects the prompt
    handleScheduledTaskResponse({
      type: "error" as any,
      id: promptId,
      timestamp: Date.now(),
      payload: { error: "Server busy" },
    });

    // Next cycle — task should be re-submittable (not blocked by dedup guard)
    await checkScheduledTasks();
    expect(sentMessages).toHaveLength(2);
  });
});

// ============================================
// Message type filtering
// ============================================

describe("handleScheduledTaskResponse — ignores irrelevant message types", () => {
  it("returns false for stream_chunk messages", () => {
    setupSend();
    expect(handleScheduledTaskResponse({
      type: "stream_chunk" as any,
      id: "x",
      timestamp: Date.now(),
      payload: {},
    })).toBe(false);
  });

  it("returns false for unrelated error messages", () => {
    setupSend();
    expect(handleScheduledTaskResponse({
      type: "error" as any,
      id: "x",
      timestamp: Date.now(),
      payload: {},
    })).toBe(false);
  });

  it("returns false for agent_complete without taskId in payload", () => {
    setupSend();
    expect(handleScheduledTaskResponse({
      type: "agent_complete",
      id: "x",
      timestamp: Date.now(),
      payload: { success: true, response: "done" },
    })).toBe(false);
  });
});
