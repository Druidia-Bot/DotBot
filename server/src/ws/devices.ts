/**
 * Device Session Management
 * 
 * Shared state for connected devices. All WS handler modules
 * import from here to access the devices Map and send helpers.
 */

import { WebSocket } from "ws";
import { nanoid } from "nanoid";
import type { WSMessage, DeviceSession, ExecutionCommand, ExecutionResult } from "../types.js";
import { isDeviceAdmin } from "../auth/device-store.js";
import { createComponentLogger } from "#logging.js";

const log = createComponentLogger("ws.devices");

// ============================================
// TYPES
// ============================================

export interface ConnectedDevice {
  ws: WebSocket;
  session: DeviceSession;
  pendingCommands: Map<string, {
    command: ExecutionCommand;
    resolve: (result: ExecutionResult) => void;
    reject: (error: Error) => void;
  }>;
  pendingMemoryRequests: Map<string, {
    resolve: (result: any) => void;
    reject: (error: Error) => void;
  }>;
  pendingSkillRequests: Map<string, {
    resolve: (result: any) => void;
    reject: (error: Error) => void;
  }>;
  pendingPersonaRequests: Map<string, {
    resolve: (result: any) => void;
    reject: (error: Error) => void;
  }>;
  pendingCouncilRequests: Map<string, {
    resolve: (result: any) => void;
    reject: (error: Error) => void;
  }>;
  pendingThreadRequests: Map<string, {
    resolve: (result: any) => void;
    reject: (error: Error) => void;
  }>;
  pendingKnowledgeRequests: Map<string, {
    resolve: (result: any) => void;
    reject: (error: Error) => void;
  }>;
  pendingToolRequests: Map<string, {
    resolve: (result: any) => void;
    reject: (error: Error) => void;
  }>;
}

export interface MemoryRequest {
  action: string;
  modelSlug?: string;
  category?: string;
  query?: string;
  data?: any;
}

export interface SkillRequest {
  action: string;
  skillSlug?: string;
  query?: string;
  language?: string;
  data?: any;
}

// ============================================
// SHARED STATE
// ============================================

export const devices = new Map<string, ConnectedDevice>();

// ============================================
// DEVICE FACTORIES & HELPERS
// ============================================

export function createConnectedDevice(ws: WebSocket, session: DeviceSession): ConnectedDevice {
  return {
    ws,
    session,
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

export function rejectAllPending(device: ConnectedDevice, error: Error): void {
  const maps: Map<string, { reject: (err: Error) => void }>[] = [
    device.pendingCommands as any,
    device.pendingMemoryRequests,
    device.pendingSkillRequests,
    device.pendingPersonaRequests,
    device.pendingCouncilRequests,
    device.pendingKnowledgeRequests,
    device.pendingToolRequests,
    device.pendingThreadRequests,
  ];
  for (const map of maps) {
    for (const [, pending] of map) {
      pending.reject(error);
    }
    map.clear();
  }
}

// ============================================
// SEND HELPERS
// ============================================

export function sendMessage(ws: WebSocket, message: WSMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

export function sendError(ws: WebSocket, error: string): void {
  sendMessage(ws, {
    type: "error",
    id: nanoid(),
    timestamp: Date.now(),
    payload: { error }
  });
}

// ============================================
// DEVICE UTILITIES
// ============================================

export function getConnectedDevices(): DeviceSession[] {
  return Array.from(devices.values()).map(d => d.session);
}

export function disconnectDevice(deviceId: string): void {
  const device = devices.get(deviceId);
  if (device) {
    device.ws.close();
    devices.delete(deviceId);
  }
}

export function broadcastToUser(userId: string, message: WSMessage): void {
  for (const device of devices.values()) {
    if (device.session.userId === userId) {
      sendMessage(device.ws, message);
    }
  }
}

/**
 * Get a local-agent device ID for a user.
 * Only returns devices with "memory" capability — browser clients cannot handle agent operations.
 */
export function getDeviceForUser(userId: string): string | null {
  let bestAgent: string | null = null;
  let bestAgentTime = 0;

  for (const [deviceId, device] of devices.entries()) {
    if (device.session.userId === userId && device.session.status === "connected") {
      // Check WebSocket is actually open
      if (device.ws.readyState !== 1 /* OPEN */) {
        log.debug(`Skipping device ${deviceId} — ws not open (state=${device.ws.readyState})`);
        continue;
      }

      // Only consider devices with "memory" capability (local-agents)
      if (device.session.capabilities?.includes("memory")) {
        const activeTime = device.session.lastActiveAt?.getTime() || 0;
        if (activeTime > bestAgentTime) {
          bestAgent = deviceId;
          bestAgentTime = activeTime;
        }
      }
    }
  }

  // Only return local-agent devices (those with "memory" capability).
  // Never fall back to browser clients — they can't handle agent operations.
  if (bestAgent) {
    const dev = devices.get(bestAgent);
    log.debug(`getDeviceForUser(${userId}) → ${dev?.session.deviceName} (${bestAgent})`, {
      capabilities: dev?.session.capabilities,
      wsState: dev?.ws.readyState,
    });
  }

  return bestAgent;
}

/**
 * Get the temp directory path for a user's connected local-agent device.
 * Returns undefined if no device is connected or device didn't send a tempDir.
 */
export function getTempDirForUser(userId: string): string | undefined {
  const deviceId = getDeviceForUser(userId);
  if (!deviceId) return undefined;
  return devices.get(deviceId)?.session.tempDir;
}

/**
 * Get the platform for a user's connected local-agent device (V2).
 * Returns undefined if no device is connected or device didn't send platform.
 */
export function getPlatformForUser(userId: string): "windows" | "linux" | "macos" | "web" | undefined {
  const deviceId = getDeviceForUser(userId);
  if (!deviceId) return undefined;
  return devices.get(deviceId)?.session.platform;
}

/**
 * Get the IANA timezone for a user's connected local-agent device.
 * Updated on each heartbeat from the client's Intl.DateTimeFormat().resolvedOptions().timeZone.
 * Returns undefined if no device is connected or timezone hasn't been reported yet.
 */
export function getTimezoneForUser(userId: string): string | undefined {
  const deviceId = getDeviceForUser(userId);
  if (!deviceId) return undefined;
  return devices.get(deviceId)?.session.timezone;
}

/**
 * Check if a user has ANY connected devices (including non-memory-capable ones like browsers).
 * Used for cleanup logic when determining if a userId's session should be cleared.
 */
export function hasAnyConnectedDevices(userId: string): boolean {
  for (const device of devices.values()) {
    if (device.session.userId === userId && device.session.status === "connected") {
      // Check WebSocket is actually open
      if (device.ws.readyState === 1 /* OPEN */) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Send a security alert to all connected admin devices.
 * Delivered as user_notification — the local agent forwards these to Discord #updates.
 */
export function notifyAdminDevices(alert: {
  title: string;
  message: string;
  level?: "warning" | "critical";
}): void {
  for (const [devId, device] of devices.entries()) {
    if (device.session.status === "connected" && isDeviceAdmin(devId)) {
      sendMessage(device.ws, {
        type: "user_notification",
        id: nanoid(),
        timestamp: Date.now(),
        payload: {
          source: "security",
          level: alert.level || "warning",
          title: alert.title,
          message: alert.message,
        },
      });
    }
  }
}
