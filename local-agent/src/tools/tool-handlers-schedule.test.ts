/**
 * Schedule Tool Handler Tests
 *
 * Covers:
 * - schedule.create: validation (name, prompt, type, time, day_of_week, interval_minutes), success
 * - schedule.list: filtering, empty results
 * - schedule.cancel: success, not found
 * - schedule.pause: success, not active
 * - schedule.resume: success, not paused
 * - Unknown tool ID
 * - Time validation: format, range (hours 0-23, minutes 0-59)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the store module
vi.mock("../scheduled-tasks/store.js", () => ({
  createScheduledTask: vi.fn(),
  listScheduledTasks: vi.fn(),
  cancelScheduledTask: vi.fn(),
  pauseScheduledTask: vi.fn(),
  resumeScheduledTask: vi.fn(),
}));

import { handleSchedule } from "./tool-handlers-schedule.js";
import {
  createScheduledTask,
  listScheduledTasks,
  cancelScheduledTask,
  pauseScheduledTask,
  resumeScheduledTask,
} from "../scheduled-tasks/store.js";
import type { ScheduledTask } from "../scheduled-tasks/store.js";

const mockCreate = vi.mocked(createScheduledTask);
const mockList = vi.mocked(listScheduledTasks);
const mockCancel = vi.mocked(cancelScheduledTask);
const mockPause = vi.mocked(pauseScheduledTask);
const mockResume = vi.mocked(resumeScheduledTask);

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
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

beforeEach(() => {
  vi.restoreAllMocks();
});

// ============================================
// DISPATCHER
// ============================================

describe("handleSchedule — dispatcher", () => {
  it("returns error for unknown tool ID", async () => {
    const result = await handleSchedule("schedule.nonexistent", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown schedule tool");
  });
});

// ============================================
// schedule.create
// ============================================

describe("schedule.create", () => {
  it("validates name is required", async () => {
    const r = await handleSchedule("schedule.create", { prompt: "x", type: "daily", time: "06:00" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("name is required");
  });

  it("validates prompt is required", async () => {
    const r = await handleSchedule("schedule.create", { name: "x", type: "daily", time: "06:00" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("prompt is required");
  });

  it("validates type is required and must be valid", async () => {
    const r1 = await handleSchedule("schedule.create", { name: "x", prompt: "y" });
    expect(r1.success).toBe(false);
    expect(r1.error).toContain("type must be one of");

    const r2 = await handleSchedule("schedule.create", { name: "x", prompt: "y", type: "monthly" });
    expect(r2.success).toBe(false);
    expect(r2.error).toContain("type must be one of");
  });

  it("validates time is required for daily schedules", async () => {
    const r = await handleSchedule("schedule.create", { name: "x", prompt: "y", type: "daily" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("time is required");
  });

  it("validates time format", async () => {
    const r = await handleSchedule("schedule.create", { name: "x", prompt: "y", type: "daily", time: "abc" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("time is required");
  });

  it("validates time range — rejects 25:00", async () => {
    const r = await handleSchedule("schedule.create", { name: "x", prompt: "y", type: "daily", time: "25:00" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("Hours must be 0-23");
  });

  it("validates time range — rejects 12:99", async () => {
    const r = await handleSchedule("schedule.create", { name: "x", prompt: "y", type: "daily", time: "12:99" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("minutes 0-59");
  });

  it("validates time is required for weekly schedules", async () => {
    const r = await handleSchedule("schedule.create", { name: "x", prompt: "y", type: "weekly", day_of_week: 1 });
    expect(r.success).toBe(false);
    expect(r.error).toContain("time is required");
  });

  it("validates day_of_week is required for weekly schedules", async () => {
    const r = await handleSchedule("schedule.create", { name: "x", prompt: "y", type: "weekly", time: "06:00" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("day_of_week is required");
  });

  it("validates day_of_week range", async () => {
    const r1 = await handleSchedule("schedule.create", { name: "x", prompt: "y", type: "weekly", time: "06:00", day_of_week: -1 });
    expect(r1.success).toBe(false);

    const r2 = await handleSchedule("schedule.create", { name: "x", prompt: "y", type: "weekly", time: "06:00", day_of_week: 7 });
    expect(r2.success).toBe(false);
  });

  it("validates interval_minutes is required for interval schedules", async () => {
    const r = await handleSchedule("schedule.create", { name: "x", prompt: "y", type: "interval" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("interval_minutes is required");
  });

  it("validates interval_minutes minimum of 5", async () => {
    const r = await handleSchedule("schedule.create", { name: "x", prompt: "y", type: "interval", interval_minutes: 2 });
    expect(r.success).toBe(false);
    expect(r.error).toContain("minimum 5 minutes");
  });

  it("creates a daily task successfully", async () => {
    const task = makeTask();
    mockCreate.mockResolvedValue(task);

    const r = await handleSchedule("schedule.create", {
      name: "Morning News",
      prompt: "Search news",
      type: "daily",
      time: "06:00",
    });

    expect(r.success).toBe(true);
    const output = JSON.parse(r.output);
    expect(output.created).toBe(true);
    expect(output.id).toBe(task.id);
    expect(output.schedule).toContain("Daily at 06:00");

    expect(mockCreate).toHaveBeenCalledWith({
      name: "Morning News",
      prompt: "Search news",
      schedule: { type: "daily", time: "06:00", dayOfWeek: undefined, intervalMinutes: undefined },
      personaHint: undefined,
      priority: "P2",
    });
  });

  it("creates a weekly task successfully", async () => {
    const task = makeTask({ schedule: { type: "weekly", time: "09:00", dayOfWeek: 1 } });
    mockCreate.mockResolvedValue(task);

    const r = await handleSchedule("schedule.create", {
      name: "Weekly Report",
      prompt: "Generate report",
      type: "weekly",
      time: "09:00",
      day_of_week: 1,
    });

    expect(r.success).toBe(true);
    const output = JSON.parse(r.output);
    expect(output.schedule).toContain("Monday");
  });

  it("creates an hourly task successfully (no time required)", async () => {
    const task = makeTask({ schedule: { type: "hourly" } });
    mockCreate.mockResolvedValue(task);

    const r = await handleSchedule("schedule.create", {
      name: "Hourly Check",
      prompt: "Check things",
      type: "hourly",
    });

    expect(r.success).toBe(true);
  });

  it("creates an interval task successfully", async () => {
    const task = makeTask({ schedule: { type: "interval", intervalMinutes: 30 } });
    mockCreate.mockResolvedValue(task);

    const r = await handleSchedule("schedule.create", {
      name: "Interval Task",
      prompt: "Do it",
      type: "interval",
      interval_minutes: 30,
    });

    expect(r.success).toBe(true);
    const output = JSON.parse(r.output);
    expect(output.schedule).toContain("30 minutes");
  });

  it("passes persona_hint and custom priority", async () => {
    mockCreate.mockResolvedValue(makeTask());

    await handleSchedule("schedule.create", {
      name: "x",
      prompt: "y",
      type: "hourly",
      persona_hint: "researcher",
      priority: "P0",
    });

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      personaHint: "researcher",
      priority: "P0",
    }));
  });

  it("handles store errors gracefully", async () => {
    mockCreate.mockRejectedValue(new Error("Disk full"));

    const r = await handleSchedule("schedule.create", {
      name: "x",
      prompt: "y",
      type: "hourly",
    });

    expect(r.success).toBe(false);
    expect(r.error).toBe("Disk full");
  });

  it("accepts day_of_week: 0 (Sunday) as valid", async () => {
    mockCreate.mockResolvedValue(makeTask({ schedule: { type: "weekly", time: "06:00", dayOfWeek: 0 } }));

    const r = await handleSchedule("schedule.create", {
      name: "Sunday",
      prompt: "Rest",
      type: "weekly",
      time: "06:00",
      day_of_week: 0,
    });

    expect(r.success).toBe(true);
    const output = JSON.parse(r.output);
    expect(output.schedule).toContain("Sunday");
  });

  it("accepts 00:00 as a valid time", async () => {
    mockCreate.mockResolvedValue(makeTask({ schedule: { type: "daily", time: "00:00" } }));

    const r = await handleSchedule("schedule.create", {
      name: "Midnight",
      prompt: "Run at midnight",
      type: "daily",
      time: "00:00",
    });

    expect(r.success).toBe(true);
  });

  it("accepts 23:59 as a valid time", async () => {
    mockCreate.mockResolvedValue(makeTask({ schedule: { type: "daily", time: "23:59" } }));

    const r = await handleSchedule("schedule.create", {
      name: "Late Night",
      prompt: "Run late",
      type: "daily",
      time: "23:59",
    });

    expect(r.success).toBe(true);
  });
});

// ============================================
// schedule.list
// ============================================

describe("schedule.list", () => {
  it("lists active tasks by default", async () => {
    const tasks = [makeTask({ id: "a" }), makeTask({ id: "b" })];
    mockList.mockResolvedValue(tasks);

    const r = await handleSchedule("schedule.list", {});

    expect(r.success).toBe(true);
    const output = JSON.parse(r.output);
    expect(output.total).toBe(2);
    expect(output.tasks).toHaveLength(2);
    expect(mockList).toHaveBeenCalledWith("active");
  });

  it("returns friendly message when no tasks found", async () => {
    mockList.mockResolvedValue([]);

    const r = await handleSchedule("schedule.list", { status: "paused" });

    expect(r.success).toBe(true);
    const output = JSON.parse(r.output);
    expect(output.total).toBe(0);
    expect(output.message).toContain("paused");
  });

  it("passes 'all' filter as undefined to store", async () => {
    mockList.mockResolvedValue([]);

    await handleSchedule("schedule.list", { status: "all" });
    expect(mockList).toHaveBeenCalledWith(undefined);
  });

  it("includes task details in output", async () => {
    const task = makeTask({
      id: "sched_detail",
      name: "Detail Task",
      lastRunAt: "2026-02-10T06:00:00.000Z",
      consecutiveFailures: 1,
    });
    mockList.mockResolvedValue([task]);

    const r = await handleSchedule("schedule.list", {});
    const output = JSON.parse(r.output);
    const t = output.tasks[0];

    expect(t.id).toBe("sched_detail");
    expect(t.name).toBe("Detail Task");
    expect(t.last_run).toBe("2026-02-10T06:00:00.000Z");
    expect(t.consecutive_failures).toBe(1);
    expect(t.schedule).toContain("Daily");
  });
});

// ============================================
// schedule.cancel
// ============================================

describe("schedule.cancel", () => {
  it("validates task_id is required", async () => {
    const r = await handleSchedule("schedule.cancel", {});
    expect(r.success).toBe(false);
    expect(r.error).toContain("task_id is required");
  });

  it("cancels a task successfully", async () => {
    mockCancel.mockResolvedValue(true);
    const r = await handleSchedule("schedule.cancel", { task_id: "sched_x" });
    expect(r.success).toBe(true);
    expect(JSON.parse(r.output).cancelled).toBe(true);
  });

  it("returns error when task not found", async () => {
    mockCancel.mockResolvedValue(false);
    const r = await handleSchedule("schedule.cancel", { task_id: "sched_nope" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("not found");
  });
});

// ============================================
// schedule.pause
// ============================================

describe("schedule.pause", () => {
  it("validates task_id is required", async () => {
    const r = await handleSchedule("schedule.pause", {});
    expect(r.success).toBe(false);
    expect(r.error).toContain("task_id is required");
  });

  it("pauses a task successfully", async () => {
    mockPause.mockResolvedValue(true);
    const r = await handleSchedule("schedule.pause", { task_id: "sched_x" });
    expect(r.success).toBe(true);
    expect(JSON.parse(r.output).paused).toBe(true);
  });

  it("returns error when task not active", async () => {
    mockPause.mockResolvedValue(false);
    const r = await handleSchedule("schedule.pause", { task_id: "sched_x" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("not active");
  });
});

// ============================================
// schedule.resume
// ============================================

describe("schedule.resume", () => {
  it("validates task_id is required", async () => {
    const r = await handleSchedule("schedule.resume", {});
    expect(r.success).toBe(false);
    expect(r.error).toContain("task_id is required");
  });

  it("resumes a task successfully", async () => {
    mockResume.mockResolvedValue(true);
    const r = await handleSchedule("schedule.resume", { task_id: "sched_x" });
    expect(r.success).toBe(true);
    expect(JSON.parse(r.output).resumed).toBe(true);
  });

  it("returns error when task not paused", async () => {
    mockResume.mockResolvedValue(false);
    const r = await handleSchedule("schedule.resume", { task_id: "sched_x" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("not paused");
  });
});
