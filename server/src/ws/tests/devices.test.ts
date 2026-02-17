/**
 * WS Device Management Tests
 * 
 * Tests device session state, send helpers, and device lookup.
 * Uses a mock WebSocket to avoid real connections.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebSocket } from "ws";
import {
  devices,
  sendMessage,
  sendError,
  getConnectedDevices,
  getDeviceForUser,
  broadcastToUser,
  type ConnectedDevice,
} from "../devices.js";

/** Create a mock WebSocket with OPEN readyState */
function mockWs(state: number = WebSocket.OPEN): WebSocket {
  return {
    readyState: state,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
}

/** Create a mock ConnectedDevice */
function mockDevice(overrides: Partial<ConnectedDevice["session"]> = {}, wsState?: number): ConnectedDevice {
  return {
    ws: mockWs(wsState),
    session: {
      id: "sess_1",
      userId: "user_demo",
      deviceId: "dev_1",
      deviceName: "Test PC",
      capabilities: ["powershell", "memory"],
      status: "connected",
      connectedAt: new Date(),
      lastActiveAt: new Date(),
      ...overrides,
    },
    pendingCommands: new Map(),
    pendingMemoryRequests: new Map(),
    pendingSkillRequests: new Map(),
    pendingPersonaRequests: new Map(),
    pendingCouncilRequests: new Map(),
    pendingThreadRequests: new Map(),
    pendingKnowledgeRequests: new Map(),
    pendingToolRequests: new Map(),
  };
}

beforeEach(() => {
  devices.clear();
});

// ============================================
// SEND HELPERS
// ============================================

describe("sendMessage", () => {
  it("sends JSON to open WebSocket", () => {
    const ws = mockWs(WebSocket.OPEN);
    const msg = { type: "ping" as const, id: "1", timestamp: Date.now(), payload: {} };
    sendMessage(ws, msg);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify(msg));
  });

  it("does not send to closed WebSocket", () => {
    const ws = mockWs(WebSocket.CLOSED);
    sendMessage(ws, { type: "ping" as const, id: "1", timestamp: Date.now(), payload: {} });
    expect(ws.send).not.toHaveBeenCalled();
  });
});

describe("sendError", () => {
  it("sends error message with correct type", () => {
    const ws = mockWs(WebSocket.OPEN);
    sendError(ws, "Something broke");
    expect(ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse((ws.send as any).mock.calls[0][0]);
    expect(sent.type).toBe("error");
    expect(sent.payload.error).toBe("Something broke");
  });
});

// ============================================
// DEVICE STATE
// ============================================

describe("getConnectedDevices", () => {
  it("returns empty array when no devices", () => {
    expect(getConnectedDevices()).toEqual([]);
  });

  it("returns sessions for all connected devices", () => {
    devices.set("dev_1", mockDevice({ deviceName: "PC 1" }));
    devices.set("dev_2", mockDevice({ deviceName: "PC 2", deviceId: "dev_2" }));
    
    const sessions = getConnectedDevices();
    expect(sessions.length).toBe(2);
    expect(sessions.map(s => s.deviceName).sort()).toEqual(["PC 1", "PC 2"]);
  });
});

// ============================================
// DEVICE LOOKUP
// ============================================

describe("getDeviceForUser", () => {
  it("returns null when no devices for user", () => {
    expect(getDeviceForUser("unknown_user")).toBeNull();
  });

  it("returns device ID for connected user", () => {
    devices.set("dev_1", mockDevice({ userId: "user_demo" }));
    expect(getDeviceForUser("user_demo")).toBe("dev_1");
  });

  it("prefers device with 'memory' capability (local-agent)", () => {
    const browser = mockDevice({
      userId: "user_demo",
      deviceId: "browser_1",
      deviceName: "Browser",
      capabilities: [],
    });
    const agent = mockDevice({
      userId: "user_demo",
      deviceId: "agent_1",
      deviceName: "Agent",
      capabilities: ["powershell", "memory"],
    });
    
    devices.set("browser_1", browser);
    devices.set("agent_1", agent);
    
    expect(getDeviceForUser("user_demo")).toBe("agent_1");
  });

  it("skips devices with non-OPEN WebSocket", () => {
    const closed = mockDevice({ userId: "user_demo" }, WebSocket.CLOSED);
    devices.set("dev_1", closed);
    
    expect(getDeviceForUser("user_demo")).toBeNull();
  });

  it("returns null for non-memory devices (browser clients can't handle agent ops)", () => {
    const browser = mockDevice({
      userId: "user_demo",
      capabilities: [],
    });
    devices.set("browser_1", browser);
    
    expect(getDeviceForUser("user_demo")).toBeNull();
  });
});

// ============================================
// BROADCAST
// ============================================

describe("broadcastToUser", () => {
  it("sends to all devices for a user", () => {
    const d1 = mockDevice({ userId: "user_demo", deviceId: "d1" });
    const d2 = mockDevice({ userId: "user_demo", deviceId: "d2" });
    const d3 = mockDevice({ userId: "other_user", deviceId: "d3" });
    
    devices.set("d1", d1);
    devices.set("d2", d2);
    devices.set("d3", d3);
    
    const msg = { type: "user_notification" as const, id: "1", timestamp: Date.now(), payload: { text: "hi" } };
    broadcastToUser("user_demo", msg);
    
    expect(d1.ws.send).toHaveBeenCalledTimes(1);
    expect(d2.ws.send).toHaveBeenCalledTimes(1);
    expect(d3.ws.send).not.toHaveBeenCalled();
  });
});
