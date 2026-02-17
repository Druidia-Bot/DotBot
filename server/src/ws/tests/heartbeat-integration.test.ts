/**
 * Heartbeat Integration Test
 * 
 * Exercises the full server-side heartbeat flow:
 *   heartbeat_request → persona loading → LLM call → HeartbeatResult → heartbeat_response
 * 
 * Mocks only: LLM providers, WS transport, device bridge
 * Does NOT mock: persona loading, HeartbeatResult construction, context injection
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { nanoid } from "nanoid";
import type { HeartbeatResult, WSMessage } from "../../types.js";

// Capture messages sent via sendMessage
const sentMessages: WSMessage[] = [];
const mockWs = { readyState: 1, send: vi.fn() };

// Mock devices module — provide a fake device with session.userId
vi.mock("../devices.js", () => ({
  devices: new Map([
    ["dev_test", {
      ws: { readyState: 1, send: vi.fn() },
      session: { userId: "user_test", capabilities: ["powershell"] },
      capabilities: ["powershell"],
    }],
  ]),
  sendMessage: vi.fn((ws: any, msg: WSMessage) => {
    sentMessages.push(msg);
  }),
}));

// Mock scheduler module — no tasks by default
vi.mock("../../services/scheduler/index.js", () => ({
  getDueTasks: vi.fn(() => []),
  getUserTasks: vi.fn(() => []),
}));

// Mock device-bridge — no tools available (LLM-only path)
vi.mock("../device-bridge.js", () => ({
  sendExecutionCommand: vi.fn(),
  requestTools: vi.fn().mockRejectedValue(new Error("No tools in test")),
}));

// Mock LLM factory — return controlled LLM client
vi.mock("../../llm/factory.js", () => ({
  createClientForSelection: vi.fn(() => ({
    provider: "deepseek",
    chat: vi.fn(),
    stream: vi.fn(),
  })),
}));

// Mock model selector — return controlled model selection
vi.mock("../../llm/selection/model-selector.js", () => ({
  selectModel: vi.fn(() => ({
    provider: "deepseek",
    model: "deepseek-chat",
    temperature: 0.2,
    maxTokens: 8192,
  })),
}));

import { handleHeartbeatRequest } from "../handlers/heartbeat.js";
import { createClientForSelection } from "#llm/factory.js";
import { getDueTasks, getUserTasks } from "../../services/scheduler/index.js";

// ============================================
// SETUP
// ============================================

beforeEach(() => {
  sentMessages.length = 0;
  vi.clearAllMocks();
});

function makeHeartbeatRequest(overrides: Record<string, any> = {}): WSMessage {
  return {
    type: "heartbeat_request",
    id: nanoid(),
    timestamp: Date.now(),
    payload: {
      checklist: "# Heartbeat\n- Check reminders\n- Check email",
      currentTime: new Date().toISOString(),
      timezone: "America/New_York",
      idleDurationMs: 300_000,
      consecutiveFailures: 0,
      ...overrides,
    },
  };
}

// ============================================
// INTEGRATION: OK RESPONSE
// ============================================

describe("Heartbeat Integration — OK flow", () => {
  it("produces a structured ok result when LLM returns HEARTBEAT_OK", async () => {
    // Configure mock LLM to return HEARTBEAT_OK
    const mockChat = vi.fn().mockResolvedValue({ content: "HEARTBEAT_OK" });
    (createClientForSelection as any).mockReturnValue({
      provider: "deepseek",
      chat: mockChat,
      stream: vi.fn(),
    });

    const request = makeHeartbeatRequest();
    await handleHeartbeatRequest("dev_test", request);

    // Verify response was sent
    expect(sentMessages).toHaveLength(1);
    const response = sentMessages[0];
    expect(response.type).toBe("heartbeat_response");
    expect(response.payload.requestId).toBe(request.id);

    // Verify structured result
    const result: HeartbeatResult = response.payload.result;
    expect(result).toBeDefined();
    expect(result.status).toBe("ok");
    expect(result.content).toBe("nothing to report");
    expect(result.model).toBe("deepseek-chat");
    expect(result.toolsAvailable).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(() => new Date(result.checkedAt)).not.toThrow();
  });

  it("strips HEARTBEAT_OK from content and preserves trailing text", async () => {
    const mockChat = vi.fn().mockResolvedValue({ content: "HEARTBEAT_OK — all systems nominal" });
    (createClientForSelection as any).mockReturnValue({
      provider: "deepseek",
      chat: mockChat,
      stream: vi.fn(),
    });

    await handleHeartbeatRequest("dev_test", makeHeartbeatRequest());

    const result: HeartbeatResult = sentMessages[0].payload.result;
    expect(result.status).toBe("ok");
    expect(result.content).toBe("— all systems nominal");
  });
});

// ============================================
// INTEGRATION: ALERT RESPONSE
// ============================================

describe("Heartbeat Integration — Alert flow", () => {
  it("produces a structured alert result when LLM returns non-OK text", async () => {
    const alertText = "Meeting with VP Eng in 20 minutes. No prep notes found.";
    const mockChat = vi.fn().mockResolvedValue({ content: alertText });
    (createClientForSelection as any).mockReturnValue({
      provider: "deepseek",
      chat: mockChat,
      stream: vi.fn(),
    });

    await handleHeartbeatRequest("dev_test", makeHeartbeatRequest());

    const result: HeartbeatResult = sentMessages[0].payload.result;
    expect(result.status).toBe("alert");
    expect(result.content).toBe(alertText);
    expect(result.model).toBe("deepseek-chat");
  });
});

// ============================================
// INTEGRATION: ERROR HANDLING
// ============================================

describe("Heartbeat Integration — Error handling", () => {
  it("produces a structured error result when LLM throws", async () => {
    const mockChat = vi.fn().mockRejectedValue(new Error("Rate limit exceeded"));
    (createClientForSelection as any).mockReturnValue({
      provider: "deepseek",
      chat: mockChat,
      stream: vi.fn(),
    });

    await handleHeartbeatRequest("dev_test", makeHeartbeatRequest());

    // Should still send a response (not crash)
    expect(sentMessages).toHaveLength(1);
    const result: HeartbeatResult = sentMessages[0].payload.result;
    expect(result.status).toBe("error");
    expect(result.content).toContain("Rate limit exceeded");
    expect(result.model).toBe("none");
    expect(result.toolsAvailable).toBe(false);
  });

  it("does not send response for unknown device", async () => {
    await handleHeartbeatRequest("nonexistent_device", makeHeartbeatRequest());
    expect(sentMessages).toHaveLength(0);
  });
});

// ============================================
// INTEGRATION: CONTEXT INJECTION (#6)
// ============================================

describe("Heartbeat Integration — Context injection", () => {
  it("includes idle duration in LLM prompt", async () => {
    const mockChat = vi.fn().mockResolvedValue({ content: "HEARTBEAT_OK" });
    (createClientForSelection as any).mockReturnValue({
      provider: "deepseek",
      chat: mockChat,
      stream: vi.fn(),
    });

    await handleHeartbeatRequest(
      "dev_test",
      makeHeartbeatRequest({ idleDurationMs: 600_000 }),
    );

    // Verify the LLM received the idle duration in the prompt
    const chatCall = mockChat.mock.calls[0];
    const userMessage = chatCall[0].find((m: any) => m.role === "user").content;
    expect(userMessage).toContain("System idle for: 10 minutes");
  });

  it("includes consecutive failures in LLM prompt", async () => {
    const mockChat = vi.fn().mockResolvedValue({ content: "HEARTBEAT_OK" });
    (createClientForSelection as any).mockReturnValue({
      provider: "deepseek",
      chat: mockChat,
      stream: vi.fn(),
    });

    await handleHeartbeatRequest(
      "dev_test",
      makeHeartbeatRequest({ consecutiveFailures: 3 }),
    );

    const chatCall = mockChat.mock.calls[0];
    const userMessage = chatCall[0].find((m: any) => m.role === "user").content;
    expect(userMessage).toContain("3 previous heartbeat(s) failed");
    expect(userMessage).toContain("recovery check");
  });

  it("omits idle info when idleDurationMs is zero", async () => {
    const mockChat = vi.fn().mockResolvedValue({ content: "HEARTBEAT_OK" });
    (createClientForSelection as any).mockReturnValue({
      provider: "deepseek",
      chat: mockChat,
      stream: vi.fn(),
    });

    await handleHeartbeatRequest(
      "dev_test",
      makeHeartbeatRequest({ idleDurationMs: 0 }),
    );

    const chatCall = mockChat.mock.calls[0];
    const userMessage = chatCall[0].find((m: any) => m.role === "user").content;
    expect(userMessage).not.toContain("System idle for");
  });
});

// ============================================
// INTEGRATION: PROMPT CONSTRUCTION
// ============================================

describe("Heartbeat Integration — Prompt", () => {
  it("includes checklist, timezone, and timestamp in LLM prompt", async () => {
    const mockChat = vi.fn().mockResolvedValue({ content: "HEARTBEAT_OK" });
    (createClientForSelection as any).mockReturnValue({
      provider: "deepseek",
      chat: mockChat,
      stream: vi.fn(),
    });

    const checklist = "# Custom\n- Check calendar\n- Check Slack";
    await handleHeartbeatRequest(
      "dev_test",
      makeHeartbeatRequest({ checklist, timezone: "Europe/London" }),
    );

    const chatCall = mockChat.mock.calls[0];
    const messages = chatCall[0];

    // System prompt should come from persona or fallback
    expect(messages[0].role).toBe("system");
    expect(messages[0].content.length).toBeGreaterThan(50);

    // User message should contain checklist and timezone
    const userMessage = messages[1].content;
    expect(userMessage).toContain("Check calendar");
    expect(userMessage).toContain("Check Slack");
    expect(userMessage).toContain("Europe/London");
    expect(userMessage).toContain("HEARTBEAT_OK");
  });

  it("uses fast model tier for heartbeat", async () => {
    const mockChat = vi.fn().mockResolvedValue({ content: "HEARTBEAT_OK" });
    (createClientForSelection as any).mockReturnValue({
      provider: "deepseek",
      chat: mockChat,
      stream: vi.fn(),
    });

    await handleHeartbeatRequest("dev_test", makeHeartbeatRequest());

    // selectModel should have been called with fast tier
    const { selectModel } = await import("#llm/selection/model-selector.js");
    expect(selectModel).toHaveBeenCalledWith({ explicitRole: "workhorse" });
  });
});
