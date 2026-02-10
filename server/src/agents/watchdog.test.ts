/**
 * Watchdog & Abort System Tests
 * 
 * Production-level tests covering:
 * - abortableCall: races async operations against AbortSignal
 * - Agent task lifecycle: spawn, activity tracking, watchdog phases
 * - Watchdog escalation: nudge → abort+investigate → kill
 * - getAbortSignal getter pattern: controller replacement after Phase 2
 * - Tool loop integration: injection queue draining after abort
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  spawnTask,
  getTaskById,
  recordTaskActivity,
  setWatchdogLLM,
  injectMessageToTask,
  activeTaskCount,
  hasActiveTask,
  getActiveTasksForDevice,
  routeInjection,
} from "./agent-tasks.js";

// ============================================
// abortableCall (extracted for testing)
// ============================================

/**
 * Inline copy of abortableCall from tool-loop.ts for unit testing.
 * The real one is a private function — this mirrors its exact logic.
 */
function abortableCall<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return fn();
  if (signal.aborted) return Promise.reject(new Error("Operation aborted by watchdog"));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new Error("Operation aborted by watchdog — task exceeded time limit. Check injection queue for investigator diagnosis."));
    };

    signal.addEventListener("abort", onAbort, { once: true });

    fn().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

// ============================================
// abortableCall UNIT TESTS
// ============================================

describe("abortableCall", () => {
  it("runs function normally when no signal provided", async () => {
    const result = await abortableCall(() => Promise.resolve("hello"));
    expect(result).toBe("hello");
  });

  it("runs function normally when signal not aborted", async () => {
    const controller = new AbortController();
    const result = await abortableCall(() => Promise.resolve(42), controller.signal);
    expect(result).toBe(42);
  });

  it("rejects immediately when signal already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      abortableCall(() => Promise.resolve("should not reach"), controller.signal)
    ).rejects.toThrow("Operation aborted by watchdog");
  });

  it("rejects when signal fires during async operation", async () => {
    const controller = new AbortController();

    const slowOp = () => new Promise<string>((resolve) => {
      setTimeout(() => resolve("slow result"), 5000);
    });

    const promise = abortableCall(slowOp, controller.signal);

    // Abort after a short delay
    setTimeout(() => controller.abort(), 50);

    await expect(promise).rejects.toThrow("Operation aborted by watchdog");
  });

  it("resolves normally if function completes before abort", async () => {
    const controller = new AbortController();

    const fastOp = () => Promise.resolve("fast result");
    const result = await abortableCall(fastOp, controller.signal);

    expect(result).toBe("fast result");

    // Aborting after completion should have no effect
    controller.abort();
  });

  it("passes through function errors when no abort", async () => {
    const controller = new AbortController();

    await expect(
      abortableCall(() => Promise.reject(new Error("tool failed")), controller.signal)
    ).rejects.toThrow("tool failed");
  });

  it("abort wins over slow function error", async () => {
    const controller = new AbortController();

    const slowFail = () => new Promise<string>((_, reject) => {
      setTimeout(() => reject(new Error("slow error")), 5000);
    });

    const promise = abortableCall(slowFail, controller.signal);
    setTimeout(() => controller.abort(), 50);

    await expect(promise).rejects.toThrow("Operation aborted by watchdog");
  });
});

// ============================================
// AGENT TASK LIFECYCLE
// ============================================

describe("Agent Task Lifecycle", () => {
  const deviceId = "test_device_lifecycle";
  const userId = "test_user_1";

  it("spawnTask creates a task with correct initial state", () => {
    const task = spawnTask(
      deviceId, userId, "build a website", "senior-dev",
      "Build Website", "Build a portfolio website",
      async () => ({ success: true, response: "done", classification: "ACTION", threadIds: [], keyPoints: [] })
    );

    expect(task.id).toMatch(/^agent_/);
    expect(task.status).toBe("running");
    expect(task.name).toBe("Build Website");
    expect(task.personaId).toBe("senior-dev");
    expect(task.injectionQueue).toEqual([]);
    expect(task.abortController).toBeInstanceOf(AbortController);
    expect(task.lastActivityAt).toBeGreaterThan(0);
    expect(task.recentActivity).toEqual([]);
    expect(task.watchdogPhase).toBe(0);
  });

  it("getTaskById returns the task", () => {
    const task = spawnTask(
      deviceId, userId, "test", "senior-dev",
      "Test Task", "Test",
      async () => ({ success: true, response: "ok", classification: "ACTION", threadIds: [], keyPoints: [] })
    );

    const found = getTaskById(task.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(task.id);
  });

  it("getTaskById returns undefined for non-existent task", () => {
    expect(getTaskById("nonexistent_task_id")).toBeUndefined();
  });

  it("recordTaskActivity updates lastActivityAt and appends to ring buffer", async () => {
    const task = spawnTask(
      deviceId, userId, "test", "senior-dev",
      "Activity Task", "Test activity",
      async () => {
        await new Promise(r => setTimeout(r, 100));
        return { success: true, response: "ok", classification: "ACTION", threadIds: [], keyPoints: [] };
      }
    );

    const initialActivity = task.lastActivityAt;

    // Small delay to ensure timestamp changes
    await new Promise(r => setTimeout(r, 10));

    recordTaskActivity(task.id, "Using filesystem.create_file");
    expect(task.lastActivityAt).toBeGreaterThanOrEqual(initialActivity);
    expect(task.recentActivity).toHaveLength(1);
    expect(task.recentActivity[0]).toContain("filesystem.create_file");
  });

  it("recordTaskActivity enforces 15-entry ring buffer limit", () => {
    const task = spawnTask(
      deviceId, userId, "test", "senior-dev",
      "Buffer Task", "Test buffer",
      async () => ({ success: true, response: "ok", classification: "ACTION", threadIds: [], keyPoints: [] })
    );

    // Add 20 entries
    for (let i = 0; i < 20; i++) {
      recordTaskActivity(task.id, `action_${i}`);
    }

    expect(task.recentActivity).toHaveLength(15);
    // Should contain the most recent entries
    expect(task.recentActivity[14]).toContain("action_19");
    expect(task.recentActivity[0]).toContain("action_5");
  });

  it("recordTaskActivity ignores non-running tasks", () => {
    const task = spawnTask(
      deviceId, userId, "test", "senior-dev",
      "Done Task", "Test",
      async () => ({ success: true, response: "ok", classification: "ACTION", threadIds: [], keyPoints: [] })
    );

    // Wait for task to complete
    return task.promise.then(() => {
      recordTaskActivity(task.id, "should be ignored");
      expect(task.recentActivity).toEqual([]);
    });
  });

  it("injectMessageToTask pushes to injection queue", () => {
    const task = spawnTask(
      deviceId, userId, "test", "senior-dev",
      "Inject Task", "Test",
      async () => {
        await new Promise(r => setTimeout(r, 200));
        return { success: true, response: "ok", classification: "ACTION", threadIds: [], keyPoints: [] };
      }
    );

    const result = injectMessageToTask(task.id, "change the color to blue");
    expect(result).toBe(true);
    expect(task.injectionQueue).toEqual(["change the color to blue"]);
  });

  it("injectMessageToTask returns false for completed tasks", async () => {
    const task = spawnTask(
      deviceId, userId, "test", "senior-dev",
      "Quick Task", "Test",
      async () => ({ success: true, response: "ok", classification: "ACTION", threadIds: [], keyPoints: [] })
    );

    await task.promise;
    const result = injectMessageToTask(task.id, "too late");
    expect(result).toBe(false);
  });

  it("activeTaskCount tracks concurrent tasks", () => {
    const device = "test_device_count";
    const before = activeTaskCount(device);

    const task1 = spawnTask(
      device, userId, "test1", "senior-dev",
      "Task 1", "First task",
      async () => {
        await new Promise(r => setTimeout(r, 200));
        return { success: true, response: "ok", classification: "ACTION", threadIds: [], keyPoints: [] };
      }
    );

    const task2 = spawnTask(
      device, userId, "test2", "junior-dev",
      "Task 2", "Second task",
      async () => {
        await new Promise(r => setTimeout(r, 200));
        return { success: true, response: "ok", classification: "ACTION", threadIds: [], keyPoints: [] };
      }
    );

    expect(activeTaskCount(device)).toBe(before + 2);
    expect(hasActiveTask(device)).toBe(true);
  });
});

// ============================================
// ABORT SIGNAL GETTER PATTERN
// ============================================

describe("AbortSignal Getter Pattern", () => {
  it("getter returns current signal from task", () => {
    const deviceId = "test_device_getter";

    const task = spawnTask(
      deviceId, "user1", "test", "senior-dev",
      "Getter Task", "Test getter",
      async () => {
        await new Promise(r => setTimeout(r, 200));
        return { success: true, response: "ok", classification: "ACTION", threadIds: [], keyPoints: [] };
      }
    );

    // Simulate the getter closure (same logic as ws/server.ts)
    const getAbortSignal = () => {
      const t = getTaskById(task.id);
      return t?.abortController.signal;
    };

    const signal1 = getAbortSignal();
    expect(signal1).toBeDefined();
    expect(signal1!.aborted).toBe(false);
  });

  it("getter returns NEW signal after controller replacement", () => {
    const deviceId = "test_device_replace";

    const task = spawnTask(
      deviceId, "user1", "test", "senior-dev",
      "Replace Task", "Test replace",
      async () => {
        await new Promise(r => setTimeout(r, 500));
        return { success: true, response: "ok", classification: "ACTION", threadIds: [], keyPoints: [] };
      }
    );

    const getAbortSignal = () => {
      const t = getTaskById(task.id);
      return t?.abortController.signal;
    };

    const signal1 = getAbortSignal();

    // Simulate Phase 2: abort + replace controller (same as watchdog scanTasks)
    task.abortController.abort();
    expect(signal1!.aborted).toBe(true);

    task.abortController = new AbortController();

    const signal2 = getAbortSignal();
    expect(signal2).toBeDefined();
    expect(signal2!.aborted).toBe(false);

    // Confirm they are different signals
    expect(signal1).not.toBe(signal2);
  });

  it("abortableCall works with getter-provided signals across replacement", async () => {
    const controller1 = new AbortController();
    let currentController = controller1;

    const getSignal = () => currentController.signal;

    // First call with original controller — abort it
    const slowOp1 = () => new Promise<string>((resolve) => {
      setTimeout(() => resolve("result1"), 5000);
    });

    const promise1 = abortableCall(slowOp1, getSignal());
    setTimeout(() => currentController.abort(), 50);
    await expect(promise1).rejects.toThrow("Operation aborted");

    // Replace controller (simulates watchdog Phase 2)
    currentController = new AbortController();

    // Second call with new controller — should work normally
    const result2 = await abortableCall(() => Promise.resolve("result2"), getSignal());
    expect(result2).toBe("result2");
  });
});

// ============================================
// WATCHDOG PHASE TRACKING
// ============================================

describe("Watchdog Phase Tracking", () => {
  it("task starts at phase 0", () => {
    const task = spawnTask(
      "device_phase", "user1", "test", "senior-dev",
      "Phase Task", "Test phases",
      async () => {
        await new Promise(r => setTimeout(r, 200));
        return { success: true, response: "ok", classification: "ACTION", threadIds: [], keyPoints: [] };
      }
    );

    expect(task.watchdogPhase).toBe(0);
  });

  it("phase can be escalated incrementally", () => {
    const task = spawnTask(
      "device_phase2", "user1", "test", "senior-dev",
      "Escalation Task", "Test escalation",
      async () => {
        await new Promise(r => setTimeout(r, 500));
        return { success: true, response: "ok", classification: "ACTION", threadIds: [], keyPoints: [] };
      }
    );

    task.watchdogPhase = 1; // nudged
    expect(task.watchdogPhase).toBe(1);

    task.watchdogPhase = 2; // aborted + investigated
    expect(task.watchdogPhase).toBe(2);

    task.watchdogPhase = 3; // killed
    expect(task.watchdogPhase).toBe(3);
  });

  it("abort controller fires and task can receive injection after", () => {
    const task = spawnTask(
      "device_abort_inject", "user1", "test", "senior-dev",
      "Abort+Inject Task", "Test abort then inject",
      async () => {
        await new Promise(r => setTimeout(r, 500));
        return { success: true, response: "ok", classification: "ACTION", threadIds: [], keyPoints: [] };
      }
    );

    // Simulate Phase 2 escalation
    task.abortController.abort();
    task.injectionQueue.push("⚠️ SYSTEM WATCHDOG — Your current operation was aborted");
    task.abortController = new AbortController();
    task.watchdogPhase = 2;

    // Verify state
    expect(task.injectionQueue).toHaveLength(1);
    expect(task.injectionQueue[0]).toContain("WATCHDOG");
    expect(task.abortController.signal.aborted).toBe(false); // New controller is fresh
    expect(task.watchdogPhase).toBe(2);
  });
});

// ============================================
// INVESTIGATOR (mock LLM)
// ============================================

describe("Watchdog LLM Setup", () => {
  it("setWatchdogLLM accepts an LLM client", () => {
    const mockLLM = {
      chat: vi.fn().mockResolvedValue({ content: "The agent is stuck on a codegen timeout." }),
    };

    // Should not throw
    expect(() => setWatchdogLLM(mockLLM as any)).not.toThrow();
  });
});

// ============================================
// IMAGEGEN MANIFEST
// ============================================

describe("Imagegen Manifest", () => {
  it("exports correct tool definitions", async () => {
    const { IMAGEGEN_TOOLS } = await import("../imagegen/manifest.js");

    expect(IMAGEGEN_TOOLS).toHaveLength(2);

    const generate = IMAGEGEN_TOOLS.find(t => t.id === "imagegen.generate");
    expect(generate).toBeDefined();
    expect(generate!.name).toBe("generate_image");
    expect(generate!.category).toBe("imagegen");
    expect(generate!.inputSchema.required).toContain("prompt");

    const edit = IMAGEGEN_TOOLS.find(t => t.id === "imagegen.edit");
    expect(edit).toBeDefined();
    expect(edit!.name).toBe("edit_image");
    expect(edit!.category).toBe("imagegen");
    expect(edit!.inputSchema.required).toContain("prompt");
    expect(edit!.inputSchema.required).toContain("image_path");
  });

  it("generate tool has all expected schema properties", async () => {
    const { IMAGEGEN_TOOLS } = await import("../imagegen/manifest.js");
    const generate = IMAGEGEN_TOOLS.find(t => t.id === "imagegen.generate")!;

    const props = Object.keys(generate.inputSchema.properties as Record<string, any>);
    expect(props).toContain("prompt");
    expect(props).toContain("save_path");
    expect(props).toContain("aspect_ratio");
    expect(props).toContain("reference_images");
    expect(props).toContain("provider");
    expect(props).toContain("size");
  });
});

// ============================================
// IMAGEGEN EXECUTOR ROUTING
// ============================================

describe("Imagegen Executor Routing", () => {
  it("rejects unknown tool IDs", async () => {
    const { executeImageGenTool } = await import("../imagegen/index.js");
    const mockExec = vi.fn();

    const result = await executeImageGenTool("imagegen.nonexistent", {}, mockExec);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown imagegen tool");
  });

  it("generate requires prompt", async () => {
    const { executeImageGenTool } = await import("../imagegen/index.js");
    const mockExec = vi.fn();

    const result = await executeImageGenTool("imagegen.generate", {}, mockExec);
    expect(result.success).toBe(false);
    expect(result.error).toContain("prompt is required");
  });

  it("edit requires prompt and image_path", async () => {
    const { executeImageGenTool } = await import("../imagegen/index.js");
    const mockExec = vi.fn();

    const result1 = await executeImageGenTool("imagegen.edit", {}, mockExec);
    expect(result1.success).toBe(false);
    expect(result1.error).toContain("prompt is required");

    const result2 = await executeImageGenTool("imagegen.edit", { prompt: "make it blue" }, mockExec);
    expect(result2.success).toBe(false);
    expect(result2.error).toContain("image_path is required");
  });

  it("generate fails gracefully when no API key configured", async () => {
    const { executeImageGenTool } = await import("../imagegen/index.js");
    const mockExec = vi.fn();

    // With no API keys set, should fail with helpful error
    const result = await executeImageGenTool("imagegen.generate", {
      prompt: "a cute cat",
      provider: "gemini"
    }, mockExec);

    // Either succeeds (if key is set) or fails with API key error
    if (!result.success) {
      expect(result.error).toMatch(/API key|failed/i);
    }
  });
});

// ============================================
// TOOL LOOP INTEGRATION (ToolLoopOptions shape)
// ============================================

describe("ToolLoopOptions Shape", () => {
  it("getAbortSignal is optional and callable", () => {
    // Verify the getter pattern works with undefined
    const options: { getAbortSignal?: () => AbortSignal | undefined } = {};
    expect(options.getAbortSignal).toBeUndefined();

    // With a getter
    const controller = new AbortController();
    options.getAbortSignal = () => controller.signal;
    expect(options.getAbortSignal()).toBe(controller.signal);
    expect(options.getAbortSignal()!.aborted).toBe(false);
  });

  it("getAbortSignal returns undefined when task is gone", () => {
    // Simulate the getter closure when task has been cleaned up
    const getAbortSignal = () => {
      const t = getTaskById("nonexistent_task_xxx");
      return t?.abortController.signal;
    };

    expect(getAbortSignal()).toBeUndefined();
  });
});

// ============================================
// INJECTION INTENT CLASSIFICATION
// ============================================

describe("Injection Intent Classification", () => {
  const userId = "test_user_intent";
  let testNum = 0;

  function spawnLongTask() {
    testNum++;
    const deviceId = `test_device_intent_${testNum}`;
    const task = spawnTask(
      deviceId, userId, "build website", "senior-dev",
      "Build SuperNurse Site", "Build the SuperNurse.ai website",
      async () => {
        await new Promise(r => setTimeout(r, 5000));
        return { success: true, response: "done", classification: "ACTION", threadIds: [], keyPoints: [] };
      }
    );
    return { task, deviceId };
  }

  it("routes status queries as status_query", async () => {
    const { task, deviceId } = spawnLongTask();

    const statusMessages = [
      "Any updates?",
      "status?",
      "any update",
      "How's it going?",
      "how is it going",
      "Are you still working?",
      "done yet?",
      "ETA?",
      "progress",
      "what's the status",
    ];

    for (const msg of statusMessages) {
      const route = await routeInjection(deviceId, msg);
      expect(route.method, `"${msg}" should be status_query`).toBe("status_query");
      expect(route.task).toBeDefined();
    }
  });

  it("injects ALL non-status messages into single running task", async () => {
    const { task, deviceId } = spawnLongTask();

    // ALL of these should be injected — the user is talking to the agent.
    // Falling through to the receptionist spawned duplicate agents.
    const injectMessages = [
      "change the color to blue",
      "can you get me that email address and help me draft it?",
      "Did you know I eat peanuts almost everyday?",
      "hello",
      "use React instead of Vue",
      "please add a login page",
      "tell me a joke",
      "what's the weather like today",
      "can you fix the header alignment",
    ];

    for (const msg of injectMessages) {
      const route = await routeInjection(deviceId, msg);
      expect(route.method, `"${msg}" should inject into running task`).toBe("single_task");
      expect(route.task).toBeDefined();
      expect(route.task!.id).toBe(task.id);
    }
  });
});
