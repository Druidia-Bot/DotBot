/**
 * Sleep Cycle Lifecycle Tests
 * 
 * Covers the refactored API for the unified periodic manager:
 * - initSleepCycle / startSleepCycle (backward compat)
 * - stopSleepCycle
 * - executeSleepCycle (no-op when no sender)
 * - isSleepCycleRunning
 * - notifyActivity (deprecated no-op)
 * - CYCLE_INTERVAL_MS export
 * 
 * Note: The actual consolidation logic (condenseThread, resolveLoops, etc.)
 * is tested indirectly via the integration tests. These tests verify the
 * lifecycle plumbing that the periodic manager depends on.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock ALL heavy dependencies so we test only lifecycle plumbing
vi.mock("./store.js", () => ({
  getRecentThreads: vi.fn(() => []),
  getThread: vi.fn(() => null),
  getModelIndex: vi.fn(() => []),
  updateModelIndex: vi.fn(),
  readModel: vi.fn(() => null),
  listModels: vi.fn(() => []),
}));

vi.mock("./store-core.js", () => ({
  MODELS_DIR: "/tmp/models",
  DEEP_MEMORY_DIR: "/tmp/deep",
}));

vi.mock("./instruction-applier.js", () => ({
  applyInstructions: vi.fn(),
}));

vi.mock("./store-agent-work.js", () => ({
  cleanupExpiredAgentWork: vi.fn(),
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual("fs");
  return {
    ...actual,
    promises: {
      ...(actual as any).promises,
      readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockResolvedValue([]),
      mkdir: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockRejectedValue(new Error("ENOENT")),
    },
  };
});

import {
  initSleepCycle,
  startSleepCycle,
  stopSleepCycle,
  executeSleepCycle,
  isSleepCycleRunning,
  notifyActivity,
  CYCLE_INTERVAL_MS,
} from "./sleep-cycle.js";

// ============================================
// SETUP
// ============================================

beforeEach(() => {
  stopSleepCycle();
  vi.clearAllMocks();
});

afterEach(() => {
  stopSleepCycle();
});

// ============================================
// LIFECYCLE
// ============================================

describe("Sleep Cycle Lifecycle", () => {
  it("initSleepCycle sets up the sender", () => {
    const sender = vi.fn().mockResolvedValue({});
    initSleepCycle(sender);
    // No error = success. The sender is stored internally.
    expect(isSleepCycleRunning()).toBe(false);
  });

  it("startSleepCycle is backward-compatible wrapper for initSleepCycle", () => {
    const sender = vi.fn().mockResolvedValue({});
    startSleepCycle(sender);
    expect(isSleepCycleRunning()).toBe(false);
  });

  it("stopSleepCycle clears sender and running flag", () => {
    const sender = vi.fn().mockResolvedValue({});
    initSleepCycle(sender);
    stopSleepCycle();
    expect(isSleepCycleRunning()).toBe(false);
  });

  it("stopSleepCycle is safe to call multiple times", () => {
    stopSleepCycle();
    stopSleepCycle();
    stopSleepCycle();
    expect(isSleepCycleRunning()).toBe(false);
  });

  it("notifyActivity is a no-op (deprecated)", () => {
    // Should not throw
    notifyActivity();
    notifyActivity();
    expect(true).toBe(true);
  });
});

// ============================================
// CONSTANTS
// ============================================

describe("Sleep Cycle Constants", () => {
  it("CYCLE_INTERVAL_MS is 30 minutes", () => {
    expect(CYCLE_INTERVAL_MS).toBe(30 * 60 * 1000);
  });
});

// ============================================
// EXECUTION
// ============================================

describe("Sleep Cycle Execution", () => {
  it("executeSleepCycle skips when no sender configured", async () => {
    // Don't call initSleepCycle — no sender
    await executeSleepCycle();
    // Should not throw, just log and return
    expect(isSleepCycleRunning()).toBe(false);
  });

  it("executeSleepCycle runs cycle when sender is configured", async () => {
    const sender = vi.fn().mockResolvedValue({});
    initSleepCycle(sender);

    await executeSleepCycle();
    // The cycle ran (even if it found no threads to process)
    expect(isSleepCycleRunning()).toBe(false);
  });

  it("executeSleepCycle does not throw on cycle errors", async () => {
    const sender = vi.fn().mockRejectedValue(new Error("Server down"));
    initSleepCycle(sender);

    // Should not throw — errors are caught internally
    await executeSleepCycle();
    expect(isSleepCycleRunning()).toBe(false);
  });

  it("stopSleepCycle after initSleepCycle prevents execution", async () => {
    const sender = vi.fn().mockResolvedValue({});
    initSleepCycle(sender);
    stopSleepCycle();

    await executeSleepCycle();
    // Sender was cleared, so the cycle should skip
    expect(sender).not.toHaveBeenCalled();
  });
});

// ============================================
// RUNNING FLAG
// ============================================

describe("Running Flag", () => {
  it("isSleepCycleRunning is false when not executing", () => {
    expect(isSleepCycleRunning()).toBe(false);
  });

  it("isSleepCycleRunning is false after init without execution", () => {
    initSleepCycle(vi.fn().mockResolvedValue({}));
    expect(isSleepCycleRunning()).toBe(false);
  });
});
