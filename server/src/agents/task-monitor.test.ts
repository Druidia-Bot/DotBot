/**
 * Task Monitor Tests
 * 
 * Covers:
 * - getTimeEstimate: classification → ms mapping
 * - startTaskTimer / clearTaskTimer: lifecycle management
 * - getActiveTaskCount: state tracking
 * - Timer fire behavior: notifications, extensions, timeout
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getTimeEstimate,
  startTaskTimer,
  clearTaskTimer,
  getActiveTaskCount,
} from "./task-monitor.js";

// ============================================
// TIME ESTIMATES
// ============================================

describe("getTimeEstimate", () => {
  it("returns 15s for INFO_REQUEST", () => {
    expect(getTimeEstimate("INFO_REQUEST")).toBe(15_000);
  });

  it("returns 30s for ACTION", () => {
    expect(getTimeEstimate("ACTION")).toBe(30_000);
  });

  it("returns 60s for COMPOUND", () => {
    expect(getTimeEstimate("COMPOUND")).toBe(60_000);
  });

  it("returns 30s for CONTINUATION", () => {
    expect(getTimeEstimate("CONTINUATION")).toBe(30_000);
  });

  it("returns 10s for CONVERSATIONAL", () => {
    expect(getTimeEstimate("CONVERSATIONAL")).toBe(10_000);
  });

  it("returns 10s for MEMORY_UPDATE", () => {
    expect(getTimeEstimate("MEMORY_UPDATE")).toBe(10_000);
  });

  it("returns 30s default for unknown classification", () => {
    expect(getTimeEstimate("UNKNOWN_TYPE")).toBe(30_000);
    expect(getTimeEstimate("")).toBe(30_000);
  });
});

// ============================================
// TIMER LIFECYCLE
// ============================================

describe("Task Timer Lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Clear any leftover timers from previous tests
    // Start fresh by clearing all known tasks
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("startTaskTimer increments active count", () => {
    const before = getActiveTaskCount();
    startTaskTimer("task_1", 5000, vi.fn());
    expect(getActiveTaskCount()).toBe(before + 1);

    // Cleanup
    clearTaskTimer("task_1");
  });

  it("clearTaskTimer decrements active count", () => {
    startTaskTimer("task_2", 5000, vi.fn());
    const before = getActiveTaskCount();
    clearTaskTimer("task_2");
    expect(getActiveTaskCount()).toBe(before - 1);
  });

  it("clearTaskTimer is safe to call on non-existent task", () => {
    expect(() => clearTaskTimer("nonexistent_task")).not.toThrow();
  });

  it("startTaskTimer replaces existing timer for same taskId", () => {
    const notify1 = vi.fn();
    const notify2 = vi.fn();
    const before = getActiveTaskCount();

    startTaskTimer("task_dup", 5000, notify1);
    startTaskTimer("task_dup", 10000, notify2);

    // Should still be only 1 extra task, not 2
    expect(getActiveTaskCount()).toBe(before + 1);

    // Advance past first timer — should NOT fire notify1
    vi.advanceTimersByTime(5000);
    expect(notify1).not.toHaveBeenCalled();

    // Advance to second timer
    vi.advanceTimersByTime(5000);
    expect(notify2).toHaveBeenCalledTimes(1);

    clearTaskTimer("task_dup");
  });

  it("fires notification when timer expires", () => {
    const notify = vi.fn();
    startTaskTimer("task_fire", 1000, notify);

    // Advance past timer
    vi.advanceTimersByTime(1000);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task_fire",
        status: "running",
      })
    );
    expect(notify.mock.calls[0][0].message).toContain("Still working");

    clearTaskTimer("task_fire");
  });

  it("extends timer after first fire (50% of original)", () => {
    const notify = vi.fn();
    startTaskTimer("task_ext", 1000, notify);

    // First fire at 1000ms
    vi.advanceTimersByTime(1000);
    expect(notify).toHaveBeenCalledTimes(1);

    // Extension at 1500ms (1000 + 500)
    vi.advanceTimersByTime(500);
    expect(notify).toHaveBeenCalledTimes(2);

    clearTaskTimer("task_ext");
  });

  it("does not fire after clearTaskTimer", () => {
    const notify = vi.fn();
    startTaskTimer("task_clear", 1000, notify);

    clearTaskTimer("task_clear");

    vi.advanceTimersByTime(2000);
    expect(notify).not.toHaveBeenCalled();
  });

  it("fires timeout after MAX_EXTENSIONS (5)", () => {
    const notify = vi.fn();
    startTaskTimer("task_timeout", 100, notify);

    // Fire 1-5: extensions (each 50ms = 50% of 100ms)
    vi.advanceTimersByTime(100); // fire 1
    vi.advanceTimersByTime(50);  // fire 2
    vi.advanceTimersByTime(50);  // fire 3
    vi.advanceTimersByTime(50);  // fire 4
    vi.advanceTimersByTime(50);  // fire 5

    // Fires 1-5 should be "running"
    expect(notify).toHaveBeenCalledTimes(5);
    for (let i = 0; i < 5; i++) {
      expect(notify.mock.calls[i][0].status).toBe("running");
    }

    // Fire 6: should be "timeout"
    vi.advanceTimersByTime(50);
    expect(notify).toHaveBeenCalledTimes(6);
    expect(notify.mock.calls[5][0].status).toBe("timeout");
    expect(notify.mock.calls[5][0].message).toContain("may be stuck");

    // Task should be removed after timeout
    // No more fires
    vi.advanceTimersByTime(1000);
    expect(notify).toHaveBeenCalledTimes(6);
  });
});
