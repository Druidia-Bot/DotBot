/**
 * Heartbeat Tests — Production Grade
 * 
 * Covers:
 * - Lifecycle: init, stop, idempotent restart
 * - Gate function: canRunHeartbeat (active hours, backoff, running flag)
 * - Structured response: ok, alert, error statuses via HeartbeatResult
 * - Backward compat: old-style { content } responses still work
 * - Alert routing: surfaces urgent notifications with exact content
 * - HEARTBEAT.md: missing file, empty file, headings-only, default creation
 * - Server response: null, empty, error, timeout
 * - Message format: correct WS message shape, payload fields, context injection
 * - Re-entrancy: running flag prevents concurrent heartbeats
 * - Outcome log: results appended to heartbeat-log.jsonl
 * 
 * Note: idle detection and overlap prevention are now the periodic manager's
 * responsibility. These tests exercise the heartbeat's own logic via
 * initHeartbeat() + executeHeartbeat(idleDurationMs).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HeartbeatResult } from "../types.js";

// Mock fs for HEARTBEAT.md reading + outcome log writing
vi.mock("fs", async () => {
  const actual = await vi.importActual("fs");
  return {
    ...actual,
    watch: vi.fn(() => ({ close: vi.fn() })), // Mock file watcher
    promises: {
      ...(actual as any).promises,
      readFile: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
      appendFile: vi.fn().mockResolvedValue(undefined),
    },
  };
});

import {
  initHeartbeat,
  startHeartbeat,
  stopHeartbeat,
  isHeartbeatRunning,
  canRunHeartbeat,
  executeHeartbeat,
  getHeartbeatIntervalMs,
  isHeartbeatEnabled,
} from "./heartbeat.js";
import { promises as fs } from "fs";

// Helper: standard checklist that won't be skipped as empty
const VALID_CHECKLIST = "# Heartbeat\n- Check reminders\n- Check email";
const IDLE_MS = 300_000; // 5 minutes idle — passed to executeHeartbeat

// Structured response helpers
function okResult(content = "nothing to report"): { result: HeartbeatResult } {
  return {
    result: {
      status: "ok",
      content,
      checkedAt: new Date().toISOString(),
      durationMs: 150,
      model: "deepseek-chat",
      toolsAvailable: false,
    },
  };
}

function alertResult(content: string): { result: HeartbeatResult } {
  return {
    result: {
      status: "alert",
      content,
      checkedAt: new Date().toISOString(),
      durationMs: 200,
      model: "deepseek-chat",
      toolsAvailable: true,
    },
  };
}

function errorResult(content = "LLM timeout"): { result: HeartbeatResult } {
  return {
    result: {
      status: "error",
      content,
      checkedAt: new Date().toISOString(),
      durationMs: 30000,
      model: "none",
      toolsAvailable: false,
    },
  };
}

// ============================================
// SETUP
// ============================================

beforeEach(() => {
  stopHeartbeat();
  vi.clearAllMocks();
});

afterEach(() => {
  stopHeartbeat();
});

// ============================================
// LIFECYCLE
// ============================================

describe("Heartbeat Lifecycle", () => {
  it("reports running state as false initially", () => {
    const sender = vi.fn().mockResolvedValue(okResult());
    initHeartbeat(sender);
    expect(isHeartbeatRunning()).toBe(false);
  });

  it("stops cleanly and resets running state", () => {
    const sender = vi.fn().mockResolvedValue(okResult());
    initHeartbeat(sender);
    stopHeartbeat();
    expect(isHeartbeatRunning()).toBe(false);
  });

  it("canRunHeartbeat returns false when disabled", () => {
    const sender = vi.fn();
    initHeartbeat(sender, undefined, { enabled: false, intervalMs: 5000 });
    expect(canRunHeartbeat()).toBe(false);
  });

  it("stopHeartbeat is safe to call multiple times", () => {
    stopHeartbeat();
    stopHeartbeat();
    stopHeartbeat();
    expect(isHeartbeatRunning()).toBe(false);
  });

  it("stopHeartbeat clears sender — executeHeartbeat is a no-op after stop", async () => {
    const sender = vi.fn().mockResolvedValue(okResult());
    (fs.readFile as any).mockResolvedValue(VALID_CHECKLIST);

    initHeartbeat(sender);
    stopHeartbeat();

    await executeHeartbeat(IDLE_MS);
    expect(sender).not.toHaveBeenCalled();
  });

  it("getHeartbeatIntervalMs returns configured interval", () => {
    initHeartbeat(vi.fn(), undefined, { intervalMs: 10 * 60 * 1000, enabled: true });
    expect(getHeartbeatIntervalMs()).toBe(10 * 60 * 1000);
  });

  it("isHeartbeatEnabled reflects config", () => {
    initHeartbeat(vi.fn(), undefined, { enabled: false });
    expect(isHeartbeatEnabled()).toBe(false);
  });

  it("backward-compat startHeartbeat calls initHeartbeat", () => {
    const sender = vi.fn().mockResolvedValue(okResult());
    startHeartbeat(sender, undefined, { intervalMs: 7000, enabled: true });
    expect(getHeartbeatIntervalMs()).toBe(7000);
    expect(canRunHeartbeat()).toBe(true);
  });
});

// ============================================
// GATE FUNCTION
// ============================================

describe("Gate Function (canRunHeartbeat)", () => {
  it("returns true when enabled and no backoff", () => {
    initHeartbeat(vi.fn().mockResolvedValue(okResult()));
    expect(canRunHeartbeat()).toBe(true);
  });

  it("returns false when disabled", () => {
    initHeartbeat(vi.fn(), undefined, { enabled: false });
    expect(canRunHeartbeat()).toBe(false);
  });

  it("returns false during active hours restriction", () => {
    // Set active hours to a time that has definitely passed (00:00–00:01)
    initHeartbeat(vi.fn(), undefined, { enabled: true, activeHours: { start: "00:00", end: "00:01" } });
    // Unless we're testing at midnight, this should be false
    const now = new Date();
    const inRange = now.getHours() === 0 && now.getMinutes() <= 1;
    expect(canRunHeartbeat()).toBe(inRange);
  });
});

// ============================================
// STRUCTURED RESPONSE (#11)
// ============================================

describe("Structured Response", () => {
  it("routes ok status to onOk callback", async () => {
    const sender = vi.fn().mockResolvedValue(okResult("all clear"));
    (fs.readFile as any).mockResolvedValue(VALID_CHECKLIST);
    const onOk = vi.fn();
    const onAlert = vi.fn();

    initHeartbeat(sender, { onOk, onAlert });
    await executeHeartbeat(IDLE_MS);

    expect(onOk).toHaveBeenCalledWith("all clear");
    expect(onAlert).not.toHaveBeenCalled();
  });

  it("routes alert status to onAlert callback", async () => {
    const alertMsg = "Meeting with Sarah in 25 minutes.";
    const sender = vi.fn().mockResolvedValue(alertResult(alertMsg));
    (fs.readFile as any).mockResolvedValue(VALID_CHECKLIST);
    const onOk = vi.fn();
    const onAlert = vi.fn();

    initHeartbeat(sender, { onOk, onAlert });
    await executeHeartbeat(IDLE_MS);

    expect(onAlert).toHaveBeenCalledWith(alertMsg);
    expect(onOk).not.toHaveBeenCalled();
  });

  it("error status counts as failure (no callback)", async () => {
    const sender = vi.fn().mockResolvedValue(errorResult("LLM crashed"));
    (fs.readFile as any).mockResolvedValue(VALID_CHECKLIST);
    const onOk = vi.fn();
    const onAlert = vi.fn();

    initHeartbeat(sender, { onOk, onAlert });
    await executeHeartbeat(IDLE_MS);

    expect(onOk).not.toHaveBeenCalled();
    expect(onAlert).not.toHaveBeenCalled();
  });

  it("writes outcome to log file on ok", async () => {
    const sender = vi.fn().mockResolvedValue(okResult());
    (fs.readFile as any).mockResolvedValue(VALID_CHECKLIST);

    initHeartbeat(sender);
    await executeHeartbeat(IDLE_MS);

    expect(fs.appendFile).toHaveBeenCalled();
    const logCall = (fs.appendFile as any).mock.calls[0];
    const entry = JSON.parse(logCall[1].trim());
    expect(entry.status).toBe("ok");
    expect(entry.loggedAt).toBeDefined();
  });

  it("writes outcome to log file on alert", async () => {
    const sender = vi.fn().mockResolvedValue(alertResult("urgent item"));
    (fs.readFile as any).mockResolvedValue(VALID_CHECKLIST);

    initHeartbeat(sender);
    await executeHeartbeat(IDLE_MS);

    expect(fs.appendFile).toHaveBeenCalled();
    const logCall = (fs.appendFile as any).mock.calls[0];
    const entry = JSON.parse(logCall[1].trim());
    expect(entry.status).toBe("alert");
    expect(entry.content).toBe("urgent item");
  });
});

// ============================================
// BACKWARD COMPAT (old-style { content } response)
// ============================================

describe("Backward Compat", () => {
  it("handles old-style HEARTBEAT_OK response", async () => {
    const sender = vi.fn().mockResolvedValue({ content: "HEARTBEAT_OK" });
    (fs.readFile as any).mockResolvedValue(VALID_CHECKLIST);
    const onOk = vi.fn();
    const onAlert = vi.fn();

    initHeartbeat(sender, { onOk, onAlert });
    await executeHeartbeat(IDLE_MS);

    expect(onOk).toHaveBeenCalled();
    expect(onAlert).not.toHaveBeenCalled();
  });

  it("handles old-style alert response", async () => {
    const sender = vi.fn().mockResolvedValue({ content: "Urgent: server down" });
    (fs.readFile as any).mockResolvedValue(VALID_CHECKLIST);
    const onOk = vi.fn();
    const onAlert = vi.fn();

    initHeartbeat(sender, { onOk, onAlert });
    await executeHeartbeat(IDLE_MS);

    expect(onAlert).toHaveBeenCalledWith("Urgent: server down");
    expect(onOk).not.toHaveBeenCalled();
  });
});

// ============================================
// HEARTBEAT.MD HANDLING
// ============================================

describe("HEARTBEAT.md Handling", () => {
  it("creates default HEARTBEAT.md when file doesn't exist", async () => {
    const sender = vi.fn().mockResolvedValue(okResult());
    (fs.readFile as any).mockRejectedValue(new Error("ENOENT"));
    (fs.writeFile as any).mockResolvedValue(undefined);
    (fs.mkdir as any).mockResolvedValue(undefined);

    initHeartbeat(sender);
    await executeHeartbeat(IDLE_MS);

    expect(fs.mkdir).toHaveBeenCalled();
    expect(fs.writeFile).toHaveBeenCalled();
    expect(sender).toHaveBeenCalled();
  });

  it("still runs if default file creation fails", async () => {
    const sender = vi.fn().mockResolvedValue(okResult());
    (fs.readFile as any).mockRejectedValue(new Error("ENOENT"));
    (fs.writeFile as any).mockRejectedValue(new Error("EPERM"));
    (fs.mkdir as any).mockRejectedValue(new Error("EPERM"));

    initHeartbeat(sender);
    await executeHeartbeat(IDLE_MS);

    // Should still send the request with the built-in default checklist
    expect(sender).toHaveBeenCalled();
  });

  it("skips when checklist is empty (only headings)", async () => {
    const sender = vi.fn().mockResolvedValue(okResult());
    (fs.readFile as any).mockResolvedValue("# Heartbeat Checklist\n## Section\n");

    initHeartbeat(sender);
    await executeHeartbeat(IDLE_MS);

    expect(sender).not.toHaveBeenCalled();
  });

  it("skips when checklist is only whitespace and headings", async () => {
    const sender = vi.fn().mockResolvedValue(okResult());
    (fs.readFile as any).mockResolvedValue("# Title\n\n  \n## Another\n  \n");

    initHeartbeat(sender);
    await executeHeartbeat(IDLE_MS);

    expect(sender).not.toHaveBeenCalled();
  });

  it("runs when checklist has at least one non-heading line", async () => {
    const sender = vi.fn().mockResolvedValue(okResult());
    (fs.readFile as any).mockResolvedValue("# Title\n- Check reminders");

    initHeartbeat(sender);
    await executeHeartbeat(IDLE_MS);

    expect(sender).toHaveBeenCalled();
  });
});

// ============================================
// MESSAGE FORMAT
// ============================================

describe("Message Format", () => {
  it("sends correct WS message shape to server", async () => {
    const sender = vi.fn().mockResolvedValue(okResult());
    const checklist = "# Heartbeat\n- Check email\n- Check calendar";
    (fs.readFile as any).mockResolvedValue(checklist);

    initHeartbeat(sender);
    await executeHeartbeat(IDLE_MS);

    expect(sender).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "heartbeat_request",
        id: expect.any(String),
        timestamp: expect.any(Number),
        payload: expect.objectContaining({
          checklist,
          currentTime: expect.any(String),
          timezone: expect.any(String),
          idleDurationMs: expect.any(Number),
          consecutiveFailures: expect.any(Number),
        }),
      })
    );
  });

  it("payload includes context injection fields (#6)", async () => {
    const sender = vi.fn().mockResolvedValue(okResult());
    (fs.readFile as any).mockResolvedValue(VALID_CHECKLIST);

    initHeartbeat(sender);
    await executeHeartbeat(IDLE_MS);

    const msg = sender.mock.calls[0][0];
    expect(msg.payload.idleDurationMs).toBe(IDLE_MS);
    expect(msg.payload.consecutiveFailures).toBe(0);
  });

  it("payload.currentTime is valid ISO string", async () => {
    const sender = vi.fn().mockResolvedValue(okResult());
    (fs.readFile as any).mockResolvedValue(VALID_CHECKLIST);

    initHeartbeat(sender);
    await executeHeartbeat(IDLE_MS);

    const msg = sender.mock.calls[0][0];
    expect(() => new Date(msg.payload.currentTime)).not.toThrow();
    expect(new Date(msg.payload.currentTime).toISOString()).toBe(msg.payload.currentTime);
  });

  it("payload.timezone is a valid IANA timezone", async () => {
    const sender = vi.fn().mockResolvedValue(okResult());
    (fs.readFile as any).mockResolvedValue(VALID_CHECKLIST);

    initHeartbeat(sender);
    await executeHeartbeat(IDLE_MS);

    const msg = sender.mock.calls[0][0];
    expect(typeof msg.payload.timezone).toBe("string");
    expect(msg.payload.timezone.length).toBeGreaterThan(0);
  });
});

// ============================================
// SERVER RESPONSE EDGE CASES
// ============================================

describe("Server Response Edge Cases", () => {
  it("handles null response gracefully", async () => {
    const sender = vi.fn().mockResolvedValue(null);
    (fs.readFile as any).mockResolvedValue(VALID_CHECKLIST);
    const onOk = vi.fn();
    const onAlert = vi.fn();

    initHeartbeat(sender, { onOk, onAlert });
    await executeHeartbeat(IDLE_MS);

    expect(onOk).not.toHaveBeenCalled();
    expect(onAlert).not.toHaveBeenCalled();
  });

  it("handles undefined response gracefully", async () => {
    const sender = vi.fn().mockResolvedValue(undefined);
    (fs.readFile as any).mockResolvedValue(VALID_CHECKLIST);
    const onOk = vi.fn();
    const onAlert = vi.fn();

    initHeartbeat(sender, { onOk, onAlert });
    await executeHeartbeat(IDLE_MS);

    expect(onOk).not.toHaveBeenCalled();
    expect(onAlert).not.toHaveBeenCalled();
  });

  it("handles empty old-style content string gracefully", async () => {
    const sender = vi.fn().mockResolvedValue({ content: "" });
    (fs.readFile as any).mockResolvedValue(VALID_CHECKLIST);
    const onOk = vi.fn();
    const onAlert = vi.fn();

    initHeartbeat(sender, { onOk, onAlert });
    await executeHeartbeat(IDLE_MS);

    expect(onOk).not.toHaveBeenCalled();
    expect(onAlert).not.toHaveBeenCalled();
  });

  it("handles server error gracefully — does not throw", async () => {
    const sender = vi.fn().mockRejectedValue(new Error("Server down"));
    (fs.readFile as any).mockResolvedValue(VALID_CHECKLIST);

    initHeartbeat(sender);
    await executeHeartbeat(IDLE_MS);

    expect(isHeartbeatRunning()).toBe(false);
  });

  it("running flag is false after server error", async () => {
    const sender = vi.fn().mockRejectedValue(new Error("Timeout"));
    (fs.readFile as any).mockResolvedValue(VALID_CHECKLIST);

    initHeartbeat(sender);
    await executeHeartbeat(IDLE_MS);

    expect(isHeartbeatRunning()).toBe(false);
  });

  it("response missing both result and content triggers no callback", async () => {
    const sender = vi.fn().mockResolvedValue({ status: "ok" });
    (fs.readFile as any).mockResolvedValue(VALID_CHECKLIST);
    const onOk = vi.fn();
    const onAlert = vi.fn();

    initHeartbeat(sender, { onOk, onAlert });
    await executeHeartbeat(IDLE_MS);

    expect(onOk).not.toHaveBeenCalled();
    expect(onAlert).not.toHaveBeenCalled();
  });
});

// ============================================
// RE-ENTRANCY & CONCURRENCY
// ============================================

describe("Re-entrancy", () => {
  it("running flag prevents concurrent heartbeats via canRunHeartbeat", async () => {
    let resolveFirst: (val: any) => void;
    const slowPromise = new Promise(resolve => { resolveFirst = resolve; });
    (fs.readFile as any).mockResolvedValue(VALID_CHECKLIST);

    const sender = vi.fn()
      .mockReturnValueOnce(slowPromise)
      .mockResolvedValue(okResult());

    initHeartbeat(sender, undefined, { intervalMs: 10_000, enabled: true });

    // Start first heartbeat (don't await — it's blocked on slowPromise)
    const firstRun = executeHeartbeat(IDLE_MS);

    // While first is running, canRunHeartbeat should return false
    expect(canRunHeartbeat()).toBe(false);
    expect(isHeartbeatRunning()).toBe(true);

    // Resolve the first
    resolveFirst!(okResult());
    await firstRun;

    // Now it should be available again
    expect(canRunHeartbeat()).toBe(true);
    expect(isHeartbeatRunning()).toBe(false);
  });
});

// ============================================
// CALLBACKS
// ============================================

describe("Callbacks", () => {
  it("works without callbacks (no onAlert/onOk)", async () => {
    const sender = vi.fn().mockResolvedValue(okResult());
    (fs.readFile as any).mockResolvedValue(VALID_CHECKLIST);

    // No callbacks — should not throw
    initHeartbeat(sender);
    await executeHeartbeat(IDLE_MS);

    expect(sender).toHaveBeenCalled();
  });

  it("works with only onAlert callback", async () => {
    const sender = vi.fn().mockResolvedValue(alertResult("Urgent: server down"));
    (fs.readFile as any).mockResolvedValue(VALID_CHECKLIST);
    const onAlert = vi.fn();

    initHeartbeat(sender, { onAlert });
    await executeHeartbeat(IDLE_MS);

    expect(onAlert).toHaveBeenCalledWith("Urgent: server down");
  });

  it("works with only onOk callback", async () => {
    const sender = vi.fn().mockResolvedValue(okResult());
    (fs.readFile as any).mockResolvedValue(VALID_CHECKLIST);
    const onOk = vi.fn();

    initHeartbeat(sender, { onOk });
    await executeHeartbeat(IDLE_MS);

    expect(onOk).toHaveBeenCalled();
  });
});
