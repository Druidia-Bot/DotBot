/**
 * Device Registration & Authentication
 *
 * Handles the two auth flows:
 * - register_device: First-time registration via invite token
 * - auth: Returning device authentication via device credentials
 *
 * Includes version check + update push after successful auth.
 */

import { WebSocket } from "ws";
import { nanoid } from "nanoid";
import type {
  WSAuthMessage,
  WSRegisterDeviceMessage,
  DeviceSession,
} from "../../types.js";
import {
  devices,
  sendMessage,
  sendError,
  createConnectedDevice,
  notifyAdminDevices,
} from "../devices.js";
import { validateAndConsumeToken } from "../../auth/invite-tokens.js";
import {
  registerDevice,
  authenticateDevice,
  getRecentFailures,
  logAuthEvent,
} from "../../auth/device-store.js";
import { notifyOfflineRecurringResults } from "../lifecycle/post-auth.js";
import { createComponentLogger } from "#logging.js";

const log = createComponentLogger("ws.auth");

// Version update push cooldown — prevents spamming the agent on every reconnect
const UPDATE_PUSH_COOLDOWN_MS = 10 * 60_000; // 10 minutes
let lastUpdatePushAt = 0;

// ============================================
// DEVICE REGISTRATION (invite token flow)
// ============================================

export function handleRegisterDevice(
  ws: WebSocket,
  message: WSRegisterDeviceMessage,
  provider: string,
  model: string,
): string | null {
  const { inviteToken, label, hwFingerprint, capabilities, tempDir, platform } = message.payload;

  if (!inviteToken || !hwFingerprint || !label) {
    sendMessage(ws, {
      type: "auth_failed",
      id: nanoid(),
      timestamp: Date.now(),
      payload: { reason: "missing_fields", message: "inviteToken and hwFingerprint are required" },
    });
    return null;
  }

  const tokenResult = validateAndConsumeToken(inviteToken);
  if (!tokenResult.valid) {
    log.warn("Device registration failed: invalid invite token", { reason: tokenResult.reason });
    sendMessage(ws, {
      type: "auth_failed",
      id: nanoid(),
      timestamp: Date.now(),
      payload: { reason: tokenResult.reason, message: `Invite token rejected: ${tokenResult.reason}` },
    });
    return null;
  }

  const ip = (ws as any)._socket?.remoteAddress || "unknown";
  const { deviceId, deviceSecret } = registerDevice({ label, hwFingerprint, ip });

  const session: DeviceSession = {
    id: nanoid(),
    userId: `user_${deviceId}`,
    deviceId,
    deviceName: label,
    capabilities,
    tempDir,
    platform: platform || undefined,
    connectedAt: new Date(),
    lastActiveAt: new Date(),
    status: "connected",
  };

  devices.set(deviceId, createConnectedDevice(ws, session));

  log.info(`Device registered: ${label} (${deviceId})`);

  sendMessage(ws, {
    type: "device_registered",
    id: nanoid(),
    timestamp: Date.now(),
    payload: {
      deviceId,
      deviceSecret,
      sessionId: session.id,
      provider,
      model,
    },
  });

  return deviceId;
}

// ============================================
// DEVICE AUTHENTICATION (returning device)
// ============================================

export function handleAuth(
  ws: WebSocket,
  message: WSAuthMessage,
  provider: string,
  model: string,
  serverVersion: string,
): string | null {
  const { deviceId, deviceSecret, deviceName, capabilities, tempDir, hwFingerprint, platform } = message.payload;

  const ip = (ws as any)._socket?.remoteAddress || "unknown";

  // Web clients without device credentials are rejected
  if (!deviceSecret || !hwFingerprint) {
    log.warn("Web client auth failed: missing device credentials", { ip, deviceId, hasSecret: !!deviceSecret, hasFingerprint: !!hwFingerprint });
    sendMessage(ws, {
      type: "auth_failed",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        reason: "missing_credentials",
        message: "Web clients must provide device credentials. Use the setup link provided by your local agent or an invite token."
      },
    });
    return null;
  }

  if (!deviceId || !deviceSecret || !hwFingerprint) {
    sendMessage(ws, {
      type: "auth_failed",
      id: nanoid(),
      timestamp: Date.now(),
      payload: { reason: "missing_fields", message: "deviceId, deviceSecret, and hwFingerprint are required" },
    });
    return null;
  }

  // Rate limiting: 3 failures per IP within 15 minutes
  const recentFailures = getRecentFailures(ip, 15);
  if (recentFailures >= 3) {
    log.warn("SECURITY: Rate limit exceeded", { ip, recentFailures });
    logAuthEvent({ eventType: "auth_failure", deviceId, ip, reason: "rate_limited" });
    notifyAdminDevices({
      title: "\ud83d\udea8 Rate Limit Exceeded",
      message: `IP \`${ip}\` blocked after ${recentFailures} failed auth attempts in 15 minutes. Device ID: \`${deviceId}\``,
      level: "critical",
    });
    sendMessage(ws, {
      type: "auth_failed",
      id: nanoid(),
      timestamp: Date.now(),
      payload: { reason: "rate_limited", message: "Too many failed attempts. Try again later." },
    });
    return null;
  }

  const authResult = authenticateDevice({ deviceId, deviceSecret, hwFingerprint, ip });

  if (!authResult.success) {
    log.warn("Device auth failed", { deviceId, reason: authResult.reason, ip });
    sendMessage(ws, {
      type: "auth_failed",
      id: nanoid(),
      timestamp: Date.now(),
      payload: { reason: authResult.reason, message: `Authentication failed: ${authResult.reason}` },
    });
    return null;
  }

  // Security alert on fingerprint change
  if (authResult.fingerprintChanged) {
    notifyAdminDevices({
      title: "\u26a0\ufe0f Hardware Fingerprint Changed",
      message: `Device \`${deviceId}\` (\`${authResult.device!.label}\`) authenticated from IP \`${ip}\` with a different hardware fingerprint. Fingerprint has been updated. This is normal after a code update but may indicate credential theft if unexpected.`,
      level: "warning",
    });
  }

  const isAgent = capabilities.includes("memory");
  const connectionKey = isAgent ? deviceId : `${deviceId}:browser`;

  // If this connection type was already connected (reconnect), close the old WS
  const existingDevice = devices.get(connectionKey);
  if (existingDevice && existingDevice.ws !== ws) {
    log.info(`Device ${connectionKey} reconnecting — closing stale WebSocket`);
    try { existingDevice.ws.close(); } catch { /* already closed */ }
  }

  const session: DeviceSession = {
    id: nanoid(),
    userId: `user_${deviceId}`,
    deviceId,
    deviceName: deviceName || authResult.device!.label,
    capabilities,
    tempDir,
    platform: platform || undefined,
    connectedAt: new Date(),
    lastActiveAt: new Date(),
    status: "connected",
  };

  devices.set(connectionKey, createConnectedDevice(ws, session));

  log.info(`Device authenticated: ${deviceName || authResult.device!.label} (${connectionKey})`);

  sendMessage(ws, {
    type: "auth",
    id: nanoid(),
    timestamp: Date.now(),
    payload: {
      success: true,
      sessionId: session.id,
      deviceId,
      provider,
      model,
    },
  });

  // Version check: push update if agent is behind server
  if (isAgent) {
    pushUpdateIfNeeded(ws, deviceId, message.payload.version, serverVersion);
  }

  // Notify about recurring tasks that ran while device was offline
  notifyOfflineRecurringResults(session.userId, session.connectedAt).catch(() => {});

  return connectionKey;
}

// ============================================
// VERSION CHECK
// ============================================

function pushUpdateIfNeeded(
  ws: WebSocket,
  deviceId: string,
  agentVersion: string | undefined,
  serverVersion: string,
): void {
  if (!agentVersion) {
    log.debug("Agent did not send version — skipping update check", { deviceId });
    return;
  }
  if (serverVersion === "unknown") {
    log.warn("Server VERSION file not found — cannot compare versions for auto-update", { deviceId, agentVersion });
    return;
  }
  if (agentVersion === serverVersion) {
    log.debug("Agent version matches server", { deviceId, version: serverVersion });
    return;
  }

  const now = Date.now();
  const elapsed = now - lastUpdatePushAt;

  if (elapsed < UPDATE_PUSH_COOLDOWN_MS) {
    log.info("Agent version mismatch — skipping update push (cooldown active)", {
      deviceId, agentVersion, serverVersion,
      cooldownRemainingSec: Math.ceil((UPDATE_PUSH_COOLDOWN_MS - elapsed) / 1000),
    });
    return;
  }

  log.info("Agent version mismatch — pushing update", { deviceId, agentVersion, serverVersion });

  // Small delay so the agent finishes its auth init before we trigger an update.
  // Set the cooldown timestamp only AFTER the message is sent — if the WS closes
  // before the timeout fires, we want the next reconnect to retry immediately.
  setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      log.warn("WS closed before system_update could be sent — will retry on next auth", {
        deviceId, agentVersion, serverVersion,
      });
      return; // Don't set lastUpdatePushAt — let the next auth attempt try again
    }
    lastUpdatePushAt = Date.now();
    sendMessage(ws, {
      type: "system_update" as any,
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        serverVersion,
        agentVersion,
        reason: `Server updated to ${serverVersion}, agent is on ${agentVersion}`,
      },
    });
  }, 5000);
}
