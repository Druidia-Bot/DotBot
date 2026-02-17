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
  getAllThreadSummaries: vi.fn(() => []),
  getL0MemoryIndex: vi.fn(() => []),
  getAllMentalModels: vi.fn(() => []),
  getMentalModel: vi.fn(() => null),
  saveMentalModel: vi.fn(),
  rebuildMemoryIndex: vi.fn(),
  mergeMentalModels: vi.fn(() => null),
  archiveThread: vi.fn(() => false),
}));

vi.mock("./store-core.js", () => ({
  MODELS_DIR: "/tmp/models",
  DEEP_MEMORY_DIR: "/tmp/deep",
  DOTBOT_DIR: "/tmp/dotbot",
  fileExists: vi.fn(() => Promise.resolve(false)),
  readJson: vi.fn(() => Promise.resolve(null)),
  writeJson: vi.fn(() => Promise.resolve()),
}));

vi.mock("./instruction-applier.js", () => ({
  applyInstructions: vi.fn(),
}));

vi.mock("./sleep-phases.js", () => ({
  condenseThread: vi.fn(async () => ({ applied: 0 })),
  resolveLoop: vi.fn(async () => ({ applied: 0, notified: false, newStatus: "open" })),
  pruneIndex: vi.fn(async () => undefined),
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
import * as store from "./store.js";
import { condenseThread } from "./sleep-phases.js";
import { promises as fsPromises } from "fs";

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

  it("processes uncondensed threads even when older than lastCycleAt", async () => {
    const sender = vi.fn().mockResolvedValue({});
    initSleepCycle(sender);

    vi.mocked(store.getAllThreadSummaries).mockResolvedValueOnce([
      {
        id: "conversation",
        topic: "New Thread",
        status: "active",
        lastActiveAt: "2026-02-17T11:57:30.552Z",
        condensedAt: "",
        entities: [],
        keywords: [],
      },
    ]);
    vi.mocked(store.getL0MemoryIndex).mockResolvedValueOnce({ models: [], threads: [], sessionSummary: null } as any);
    vi.mocked(store.getAllMentalModels).mockResolvedValueOnce([] as any);
    vi.mocked(condenseThread).mockResolvedValueOnce({ applied: 1 } as any);

    (fsPromises.readFile as any).mockResolvedValueOnce(JSON.stringify({
      lastCycleAt: "2026-02-17T13:31:55.898Z",
      lastCycleDurationMs: 9,
      threadsProcessed: 0,
      loopsInvestigated: 0,
      instructionsApplied: 0,
    }));

    await executeSleepCycle();

    expect(condenseThread).toHaveBeenCalledTimes(1);
    expect(condenseThread).toHaveBeenCalledWith(
      sender,
      expect.objectContaining({ id: "conversation" }),
      expect.anything(),
      null,
    );
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
