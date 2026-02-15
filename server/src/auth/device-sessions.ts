/**
 * Device Session Management
 *
 * Manages browser sessions for device-authenticated users.
 * When a browser connects via the local agent's setup server,
 * we issue a session cookie that's scoped to that device.
 */

import { nanoid } from "nanoid";
import { authenticateDevice } from "./device-store.js";
import { createComponentLogger } from "#logging.js";

const log = createComponentLogger("auth.device-sessions");

interface DeviceSession {
  sessionId: string;
  deviceId: string;
  userId: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
}

// In-memory session store (could be moved to Redis for multi-server)
const sessions = new Map<string, DeviceSession>();

// Cleanup interval: every 30 minutes
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Create a new device session after validating credentials
 */
export async function createDeviceSession(
  deviceId: string,
  deviceSecret: string,
  ip?: string // L-02 fix: Accept IP from HTTP handler
): Promise<{ sessionId: string; userId: string } | null> {
  // Validate device credentials (same as WebSocket auth)
  const authResult = authenticateDevice({
    deviceId,
    deviceSecret,
    hwFingerprint: "browser", // Browser sessions don't have hardware fingerprints
    ip: ip || "unknown", // L-02 fix: Use provided IP or fallback to "unknown"
  });

  if (!authResult.success) {
    log.warn("Device session creation failed: invalid credentials", { deviceId });
    return null;
  }

  // Create session (userId is derived from deviceId, same as WebSocket auth)
  const sessionId = nanoid(32);
  const userId = `user_${deviceId}`;
  const now = new Date();
  const session: DeviceSession = {
    sessionId,
    deviceId,
    userId,
    createdAt: now,
    lastUsedAt: now,
    expiresAt: new Date(now.getTime() + SESSION_DURATION_MS),
  };

  sessions.set(sessionId, session);
  log.info("Device session created", { deviceId, sessionId, userId });

  return { sessionId, userId };
}

/**
 * Validate a session ID and return device info
 */
export function validateDeviceSession(sessionId: string): {
  valid: boolean;
  deviceId?: string;
  userId?: string;
} {
  const session = sessions.get(sessionId);

  if (!session) {
    return { valid: false };
  }

  // Check expiration
  if (session.expiresAt < new Date()) {
    sessions.delete(sessionId);
    log.info("Device session expired", { sessionId, deviceId: session.deviceId });
    return { valid: false };
  }

  // Update last used time
  session.lastUsedAt = new Date();

  return {
    valid: true,
    deviceId: session.deviceId,
    userId: session.userId,
  };
}

/**
 * Revoke a device session
 */
export function revokeDeviceSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (session) {
    sessions.delete(sessionId);
    log.info("Device session revoked", { sessionId, deviceId: session.deviceId });
    return true;
  }
  return false;
}

/**
 * Revoke all sessions for a device
 */
export function revokeDeviceSessions(deviceId: string): number {
  let count = 0;
  for (const [sessionId, session] of sessions.entries()) {
    if (session.deviceId === deviceId) {
      sessions.delete(sessionId);
      count++;
    }
  }
  if (count > 0) {
    log.info("Device sessions revoked", { deviceId, count });
  }
  return count;
}

/**
 * Clean up expired sessions
 */
function cleanupExpiredSessions(): void {
  const now = new Date();
  let count = 0;

  for (const [sessionId, session] of sessions.entries()) {
    if (session.expiresAt < now) {
      sessions.delete(sessionId);
      count++;
    }
  }

  if (count > 0) {
    log.info("Expired device sessions cleaned up", { count });
  }
}

/**
 * Start session cleanup interval
 */
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startSessionCleanup(): void {
  if (cleanupTimer) return; // Already started

  cleanupTimer = setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);
  if (cleanupTimer.unref) cleanupTimer.unref(); // Don't keep process alive

  log.info("Device session cleanup started");
}

/**
 * Stop session cleanup (for graceful shutdown)
 */
export function stopSessionCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    log.info("Device session cleanup stopped");
  }
}

/**
 * Get session stats (for monitoring)
 */
export function getSessionStats(): {
  totalSessions: number;
  activeDevices: number;
  oldestSession: Date | null;
} {
  const deviceIds = new Set<string>();
  let oldestSession: Date | null = null;

  for (const session of sessions.values()) {
    deviceIds.add(session.deviceId);
    if (!oldestSession || session.createdAt < oldestSession) {
      oldestSession = session.createdAt;
    }
  }

  return {
    totalSessions: sessions.size,
    activeDevices: deviceIds.size,
    oldestSession,
  };
}
