/**
 * Admin WebSocket Handler
 *
 * Handles admin operations over WebSocket — only admin devices can use these.
 * Replaces the old HTTP admin endpoints with authenticated WS-only access.
 *
 * Actions:
 *   create_token  — generate a new invite token
 *   list_tokens   — list all invite tokens
 *   revoke_token  — revoke an invite token by plaintext
 *   list_devices  — list all registered devices
 *   revoke_device — revoke a registered device
 *   unrevoke_device — un-revoke a device (admin recovery after fingerprint mismatch)
 */

import { nanoid } from "nanoid";
import type { WSMessage } from "../../types.js";
import { devices, sendMessage } from "../devices.js";
import { isDeviceAdmin, listDevices, revokeDevice, unrevokeDevice } from "../../auth/device-store.js";
import { createInviteToken, listTokens, revokeToken } from "../../auth/invite-tokens.js";
import { createComponentLogger } from "#logging.js";

const log = createComponentLogger("ws.admin");

export function handleAdminRequest(deviceId: string, message: WSMessage): void {
  const device = devices.get(deviceId);
  if (!device) return;

  const { action, requestId } = message.payload;
  const respId = requestId || message.id;

  // Gate: only admin devices can use admin operations
  if (!isDeviceAdmin(deviceId)) {
    log.warn("Non-admin device attempted admin operation", { deviceId, action });
    sendMessage(device.ws, {
      type: "admin_response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: { requestId: respId, success: false, error: "Unauthorized — admin access required" },
    });
    return;
  }

  try {
    switch (action) {
      case "create_token": {
        const { maxUses = 1, expiryDays = 7, label = "WS-generated token" } = message.payload;
        const { token, expiresAt } = createInviteToken({ maxUses, expiryDays, label });
        const publicUrl = process.env.PUBLIC_URL || "http://localhost:3000";
        const inviteUrl = `${publicUrl}/invite/${token}`;
        log.info("Admin created invite token", { deviceId, label });
        sendMessage(device.ws, {
          type: "admin_response",
          id: nanoid(),
          timestamp: Date.now(),
          payload: { requestId: respId, success: true, action, data: { token, expiresAt, maxUses, label, inviteUrl } },
        });
        break;
      }

      case "list_tokens": {
        const tokens = listTokens();
        sendMessage(device.ws, {
          type: "admin_response",
          id: nanoid(),
          timestamp: Date.now(),
          payload: { requestId: respId, success: true, action, data: tokens },
        });
        break;
      }

      case "revoke_token": {
        const { token } = message.payload;
        if (!token) {
          sendMessage(device.ws, {
            type: "admin_response",
            id: nanoid(),
            timestamp: Date.now(),
            payload: { requestId: respId, success: false, error: "token is required" },
          });
          return;
        }
        const revoked = revokeToken(token);
        log.info("Admin revoked invite token", { deviceId, revoked });
        sendMessage(device.ws, {
          type: "admin_response",
          id: nanoid(),
          timestamp: Date.now(),
          payload: { requestId: respId, success: true, action, data: { revoked } },
        });
        break;
      }

      case "list_devices": {
        const deviceList = listDevices();
        sendMessage(device.ws, {
          type: "admin_response",
          id: nanoid(),
          timestamp: Date.now(),
          payload: { requestId: respId, success: true, action, data: deviceList },
        });
        break;
      }

      case "revoke_device": {
        const { targetDeviceId } = message.payload;
        if (!targetDeviceId) {
          sendMessage(device.ws, {
            type: "admin_response",
            id: nanoid(),
            timestamp: Date.now(),
            payload: { requestId: respId, success: false, error: "targetDeviceId is required" },
          });
          return;
        }
        const revoked = revokeDevice(targetDeviceId);
        log.info("Admin revoked device", { deviceId, targetDeviceId, revoked });
        sendMessage(device.ws, {
          type: "admin_response",
          id: nanoid(),
          timestamp: Date.now(),
          payload: { requestId: respId, success: true, action, data: { deviceId: targetDeviceId, revoked } },
        });
        break;
      }

      case "unrevoke_device": {
        const { targetDeviceId } = message.payload;
        if (!targetDeviceId) {
          sendMessage(device.ws, {
            type: "admin_response",
            id: nanoid(),
            timestamp: Date.now(),
            payload: { requestId: respId, success: false, error: "targetDeviceId is required" },
          });
          return;
        }
        const restored = unrevokeDevice(targetDeviceId);
        log.info("Admin un-revoked device", { deviceId, targetDeviceId, restored });
        sendMessage(device.ws, {
          type: "admin_response",
          id: nanoid(),
          timestamp: Date.now(),
          payload: { requestId: respId, success: true, action, data: { deviceId: targetDeviceId, restored } },
        });
        break;
      }

      default:
        sendMessage(device.ws, {
          type: "admin_response",
          id: nanoid(),
          timestamp: Date.now(),
          payload: { requestId: respId, success: false, error: `Unknown admin action: ${action}` },
        });
    }
  } catch (err: any) {
    log.error("Admin request failed", { deviceId, action, error: err.message });
    sendMessage(device.ws, {
      type: "admin_response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: { requestId: respId, success: false, error: err.message },
    });
  }
}
