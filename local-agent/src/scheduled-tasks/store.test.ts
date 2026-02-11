/**
 * Scheduled Tasks Store Tests
 * 
 * Covers:
 * - CRUD: create, list, get, cancel, pause, resume
 * - calculateNextRun: daily, weekly, hourly, interval edge cases
 * - getDueAndMissedTasks: grace period classification
 * - markTaskRun / markTaskFailed: state transitions, auto-pause
 * - advanceMissedTask: nextRunAt advancement
 * - File I/O: corrupt JSON warning, cancelled task pruning
 * - parseTime: valid and invalid inputs
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import { homedir } from "os";

// We need to mock fs to avoid touching the real filesystem
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
    },
  };
});

import {
  createScheduledTask,
  listScheduledTasks,
  getScheduledTask,
  cancelScheduledTask,
  pauseScheduledTask,
  resumeScheduledTask,
  getDueAndMissedTasks,
  markTaskRun,
  markTaskFailed,
  advanceMissedTask,
  calculateNextRun,
} from "./store.js";
import type { TaskSchedule, ScheduledTask } from "./store.js";

const mockReadFile = vi.mocked(fs.readFile);
const mockWriteFile = vi.mocked(fs.writeFile);
const mockMkdir = vi.mocked(fs.mkdir);

const TASKS_PATH = path.join(homedir(), ".bot", "scheduled-tasks.json");

// ============================================
// HELPERS
// ============================================

function makeMockTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "sched_test123",
    name: "Test Task",
    prompt: "Do the thing",
    schedule: { type: "daily", time: "06:00" },
    priority: "P2",
    status: "active",
    nextRunAt: "2026-02-11T06:00:00.000Z",
    consecutiveFailures: 0,
    maxFailures: 3,
    createdAt: "2026-02-10T12:00:00.000Z",
    ...overrides,
  };
}

function setStoredTasks(tasks: ScheduledTask[]): void {
  mockReadFile.mockResolvedValue(JSON.stringify(tasks) as any);
}

function getWrittenTasks(): ScheduledTask[] {
  const call = mockWriteFile.mock.calls[0];
  if (!call) return [];
  return JSON.parse(call[1] as string);
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockMkdir.mockResolvedValue(undefined as any);
  mockWriteFile.mockResolvedValue(undefined);
  // Default: empty store
  mockReadFile.mockResolvedValue("[]" as any);
});

// ============================================
// CRUD
// ============================================

describe("createScheduledTask", () => {
  it("creates a task with correct defaults and writes to file", async () => {
    const task = await createScheduledTask({
      name: "Morning News",
      prompt: "Search Fort Myers news",
      schedule: { type: "daily", time: "06:00" },
    });

    expect(task.id).toMatch(/^sched_/);
    expect(task.name).toBe("Morning News");
    expect(task.prompt).toBe("Search Fort Myers news");
    expect(task.schedule).toEqual({ type: "daily", time: "06:00" });
    expect(task.priority).toBe("P2");
    expect(task.status).toBe("active");
    expect(task.consecutiveFailures).toBe(0);
    expect(task.maxFailures).toBe(3);
    expect(task.nextRunAt).toBeTruthy();
    expect(task.createdAt).toBeTruthy();

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const written = getWrittenTasks();
    expect(written).toHaveLength(1);
    expect(written[0].id).toBe(task.id);
  });

  it("respects custom priority and personaHint", async () => {
    const task = await createScheduledTask({
      name: "Test",
      prompt: "Prompt",
      schedule: { type: "hourly" },
      priority: "P0",
      personaHint: "researcher",
    });

    expect(task.priority).toBe("P0");
    expect(task.personaHint).toBe("researcher");
  });

  it("appends to existing tasks", async () => {
    const existing = makeMockTask({ id: "sched_existing" });
    setStoredTasks([existing]);

    const task = await createScheduledTask({
      name: "New Task",
      prompt: "Prompt",
      schedule: { type: "hourly" },
    });

    const written = getWrittenTasks();
    expect(written).toHaveLength(2);
    expect(written[0].id).toBe("sched_existing");
    expect(written[1].id).toBe(task.id);
  });
});

describe("listScheduledTasks", () => {
  it("returns all tasks when no filter", async () => {
    setStoredTasks([
      makeMockTask({ id: "a", status: "active" }),
      makeMockTask({ id: "b", status: "paused" }),
      makeMockTask({ id: "c", status: "cancelled" }),
    ]);
    const all = await listScheduledTasks();
    expect(all).toHaveLength(3);
  });

  it("filters by status", async () => {
    setStoredTasks([
      makeMockTask({ id: "a", status: "active" }),
      makeMockTask({ id: "b", status: "paused" }),
    ]);
    const active = await listScheduledTasks("active");
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe("a");
  });

  it("returns all when filter is 'all'", async () => {
    setStoredTasks([
      makeMockTask({ id: "a", status: "active" }),
      makeMockTask({ id: "b", status: "cancelled" }),
    ]);
    const all = await listScheduledTasks("all");
    expect(all).toHaveLength(2);
  });
});

describe("getScheduledTask", () => {
  it("returns task by ID", async () => {
    setStoredTasks([makeMockTask({ id: "sched_find_me" })]);
    const task = await getScheduledTask("sched_find_me");
    expect(task?.id).toBe("sched_find_me");
  });

  it("returns null for nonexistent ID", async () => {
    setStoredTasks([makeMockTask()]);
    const task = await getScheduledTask("sched_nonexistent");
    expect(task).toBeNull();
  });
});

describe("cancelScheduledTask", () => {
  it("cancels an active task", async () => {
    setStoredTasks([makeMockTask({ id: "sched_x", status: "active" })]);
    const result = await cancelScheduledTask("sched_x");
    expect(result).toBe(true);
    expect(getWrittenTasks()[0].status).toBe("cancelled");
  });

  it("cancels a paused task", async () => {
    setStoredTasks([makeMockTask({ id: "sched_x", status: "paused" })]);
    const result = await cancelScheduledTask("sched_x");
    expect(result).toBe(true);
  });

  it("returns false for already cancelled task", async () => {
    setStoredTasks([makeMockTask({ id: "sched_x", status: "cancelled" })]);
    const result = await cancelScheduledTask("sched_x");
    expect(result).toBe(false);
  });

  it("returns false for nonexistent ID", async () => {
    setStoredTasks([]);
    const result = await cancelScheduledTask("sched_nope");
    expect(result).toBe(false);
  });
});

describe("pauseScheduledTask", () => {
  it("pauses an active task", async () => {
    setStoredTasks([makeMockTask({ id: "sched_x", status: "active" })]);
    const result = await pauseScheduledTask("sched_x");
    expect(result).toBe(true);
    expect(getWrittenTasks()[0].status).toBe("paused");
  });

  it("returns false for non-active task", async () => {
    setStoredTasks([makeMockTask({ id: "sched_x", status: "paused" })]);
    const result = await pauseScheduledTask("sched_x");
    expect(result).toBe(false);
  });
});

describe("resumeScheduledTask", () => {
  it("resumes a paused task and resets failures", async () => {
    setStoredTasks([makeMockTask({
      id: "sched_x",
      status: "paused",
      consecutiveFailures: 3,
    })]);
    const result = await resumeScheduledTask("sched_x");
    expect(result).toBe(true);
    const written = getWrittenTasks()[0];
    expect(written.status).toBe("active");
    expect(written.consecutiveFailures).toBe(0);
    expect(written.nextRunAt).toBeTruthy();
  });

  it("returns false for active task", async () => {
    setStoredTasks([makeMockTask({ id: "sched_x", status: "active" })]);
    const result = await resumeScheduledTask("sched_x");
    expect(result).toBe(false);
  });
});

// ============================================
// DUE / MISSED DETECTION
// ============================================

describe("getDueAndMissedTasks", () => {
  it("returns due task when within grace period", async () => {
    const now = Date.now();
    setStoredTasks([makeMockTask({
      id: "sched_due",
      status: "active",
      nextRunAt: new Date(now - 60_000).toISOString(), // 1 minute ago
    })]);
    const result = await getDueAndMissedTasks();
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("due");
  });

  it("returns missed task when beyond 2-hour grace period", async () => {
    const now = Date.now();
    setStoredTasks([makeMockTask({
      id: "sched_missed",
      status: "active",
      nextRunAt: new Date(now - 3 * 60 * 60 * 1000).toISOString(), // 3 hours ago
    })]);
    const result = await getDueAndMissedTasks();
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("missed");
  });

  it("ignores tasks scheduled in the future", async () => {
    setStoredTasks([makeMockTask({
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
    })]);
    const result = await getDueAndMissedTasks();
    expect(result).toHaveLength(0);
  });

  it("ignores paused and cancelled tasks", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    setStoredTasks([
      makeMockTask({ id: "a", status: "paused", nextRunAt: past }),
      makeMockTask({ id: "b", status: "cancelled", nextRunAt: past }),
    ]);
    const result = await getDueAndMissedTasks();
    expect(result).toHaveLength(0);
  });
});

// ============================================
// AFTER-RUN UPDATES
// ============================================

describe("markTaskRun", () => {
  it("updates lastRunAt, clears error, resets failures, advances nextRunAt", async () => {
    setStoredTasks([makeMockTask({
      id: "sched_x",
      consecutiveFailures: 2,
      lastError: "previous error",
    })]);

    await markTaskRun("sched_x", "Some result text");

    const written = getWrittenTasks()[0];
    expect(written.lastRunAt).toBeTruthy();
    expect(written.lastResult).toBe("Some result text");
    expect(written.lastError).toBeUndefined();
    expect(written.consecutiveFailures).toBe(0);
    expect(written.nextRunAt).not.toBe("2026-02-11T06:00:00.000Z");
  });

  it("truncates result to 2000 chars", async () => {
    setStoredTasks([makeMockTask({ id: "sched_x" })]);
    const longResult = "x".repeat(5000);
    await markTaskRun("sched_x", longResult);
    expect(getWrittenTasks()[0].lastResult).toHaveLength(2000);
  });

  it("no-ops for nonexistent task", async () => {
    setStoredTasks([]);
    await markTaskRun("sched_nope", "result");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});

describe("markTaskFailed", () => {
  it("increments failures and records error", async () => {
    setStoredTasks([makeMockTask({ id: "sched_x", consecutiveFailures: 0 })]);

    const paused = await markTaskFailed("sched_x", "Network error");

    expect(paused).toBe(false);
    const written = getWrittenTasks()[0];
    expect(written.consecutiveFailures).toBe(1);
    expect(written.lastError).toBe("Network error");
    expect(written.status).toBe("active");
  });

  it("pauses task when maxFailures reached", async () => {
    setStoredTasks([makeMockTask({ id: "sched_x", consecutiveFailures: 2, maxFailures: 3 })]);

    const paused = await markTaskFailed("sched_x", "Third failure");

    expect(paused).toBe(true);
    expect(getWrittenTasks()[0].status).toBe("paused");
  });

  it("returns false for nonexistent task", async () => {
    setStoredTasks([]);
    const result = await markTaskFailed("sched_nope", "error");
    expect(result).toBe(false);
  });
});

describe("advanceMissedTask", () => {
  it("advances nextRunAt without changing other fields", async () => {
    const task = makeMockTask({ id: "sched_x", consecutiveFailures: 1 });
    setStoredTasks([task]);

    await advanceMissedTask("sched_x");

    const written = getWrittenTasks()[0];
    expect(written.nextRunAt).not.toBe(task.nextRunAt);
    expect(written.consecutiveFailures).toBe(1); // unchanged
    expect(written.status).toBe("active"); // unchanged
  });
});

// ============================================
// calculateNextRun
// ============================================

describe("calculateNextRun", () => {
  describe("daily", () => {
    it("schedules for today if time hasn't passed", () => {
      const ref = new Date("2026-02-10T05:00:00");
      const next = calculateNextRun({ type: "daily", time: "06:00" }, ref);
      expect(next.getHours()).toBe(6);
      expect(next.getMinutes()).toBe(0);
      expect(next.getDate()).toBe(10);
    });

    it("schedules for tomorrow if time already passed", () => {
      const ref = new Date("2026-02-10T07:00:00");
      const next = calculateNextRun({ type: "daily", time: "06:00" }, ref);
      expect(next.getHours()).toBe(6);
      expect(next.getDate()).toBe(11);
    });

    it("schedules for tomorrow if exactly at scheduled time", () => {
      const ref = new Date("2026-02-10T06:00:00.000");
      const next = calculateNextRun({ type: "daily", time: "06:00" }, ref);
      expect(next.getDate()).toBe(11);
    });

    it("defaults to 09:00 if time is missing", () => {
      const ref = new Date("2026-02-10T05:00:00");
      const next = calculateNextRun({ type: "daily" }, ref);
      expect(next.getHours()).toBe(9);
      expect(next.getMinutes()).toBe(0);
    });
  });

  describe("weekly", () => {
    it("schedules for the target day this week if not yet passed", () => {
      // Feb 10, 2026 is a Tuesday (day 2)
      const ref = new Date("2026-02-10T05:00:00");
      const next = calculateNextRun({ type: "weekly", time: "09:00", dayOfWeek: 3 }, ref); // Wednesday
      expect(next.getDay()).toBe(3);
      expect(next.getDate()).toBe(11); // Feb 11 is Wednesday
    });

    it("schedules for next week if target day already passed", () => {
      // Feb 10, 2026 is Tuesday (day 2)
      const ref = new Date("2026-02-10T10:00:00");
      const next = calculateNextRun({ type: "weekly", time: "09:00", dayOfWeek: 1 }, ref); // Monday
      expect(next.getDay()).toBe(1);
      expect(next.getDate()).toBe(16); // next Monday
    });

    it("schedules for next week if same day and time passed", () => {
      const ref = new Date("2026-02-10T10:00:00"); // Tuesday 10am
      const next = calculateNextRun({ type: "weekly", time: "09:00", dayOfWeek: 2 }, ref);
      expect(next.getDay()).toBe(2);
      expect(next.getDate()).toBe(17); // next Tuesday
    });

    it("defaults to Monday if dayOfWeek not set", () => {
      const ref = new Date("2026-02-10T05:00:00"); // Tuesday
      const next = calculateNextRun({ type: "weekly", time: "09:00" }, ref);
      expect(next.getDay()).toBe(1); // Monday
    });
  });

  describe("hourly", () => {
    it("schedules for the next top-of-hour", () => {
      const ref = new Date("2026-02-10T14:35:22");
      const next = calculateNextRun({ type: "hourly" }, ref);
      expect(next.getHours()).toBe(15);
      expect(next.getMinutes()).toBe(0);
      expect(next.getSeconds()).toBe(0);
    });

    it("wraps to next day at 23:xx", () => {
      const ref = new Date("2026-02-10T23:45:00");
      const next = calculateNextRun({ type: "hourly" }, ref);
      expect(next.getDate()).toBe(11);
      expect(next.getHours()).toBe(0);
    });
  });

  describe("interval", () => {
    it("adds intervalMinutes from reference time", () => {
      const ref = new Date("2026-02-10T14:00:00");
      const next = calculateNextRun({ type: "interval", intervalMinutes: 30 }, ref);
      expect(next.getTime()).toBe(ref.getTime() + 30 * 60_000);
    });

    it("defaults to 60 minutes if intervalMinutes missing", () => {
      const ref = new Date("2026-02-10T14:00:00");
      const next = calculateNextRun({ type: "interval" }, ref);
      expect(next.getTime()).toBe(ref.getTime() + 60 * 60_000);
    });
  });

  describe("unknown type", () => {
    it("falls back to 1 hour from now", () => {
      const ref = new Date("2026-02-10T14:00:00");
      const next = calculateNextRun({ type: "bogus" as any }, ref);
      expect(next.getTime()).toBe(ref.getTime() + 3_600_000);
    });
  });
});

// ============================================
// FILE I/O EDGE CASES
// ============================================

describe("file I/O", () => {
  it("handles ENOENT silently (first run, no file)", async () => {
    const err = new Error("ENOENT") as any;
    err.code = "ENOENT";
    mockReadFile.mockRejectedValue(err);

    const consoleSpy = vi.spyOn(console, "warn");
    const tasks = await listScheduledTasks();
    expect(tasks).toEqual([]);
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("warns on corrupt JSON", async () => {
    mockReadFile.mockResolvedValue("not valid json" as any);

    const consoleSpy = vi.spyOn(console, "warn");
    const tasks = await listScheduledTasks();
    expect(tasks).toEqual([]);
    expect(consoleSpy).toHaveBeenCalledOnce();
    consoleSpy.mockRestore();
  });

  it("prunes cancelled tasks older than 7 days on write", async () => {
    const oldCancelled = makeMockTask({
      id: "old",
      status: "cancelled",
      createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const recentCancelled = makeMockTask({
      id: "recent",
      status: "cancelled",
      createdAt: new Date().toISOString(),
    });
    const active = makeMockTask({ id: "active", status: "active" });

    setStoredTasks([oldCancelled, recentCancelled, active]);

    // Trigger a write via cancel
    await cancelScheduledTask("active");

    const written = getWrittenTasks();
    const ids = written.map(t => t.id);
    expect(ids).not.toContain("old");
    expect(ids).toContain("recent");
    expect(ids).toContain("active");
  });
});
