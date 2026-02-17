/**
 * Authentication — Device registration and auth message construction.
 *
 * Builds and sends the auth or register_device message to the server.
 */

import { nanoid } from "nanoid";
import { TEMP_DIR } from "../memory/store-core.js";
import { AGENT_VERSION, DEVICE_NAME, deviceCredentials, setDeviceCredentials, hwFingerprint } from "./config.js";
import { deleteDeviceCredentials } from "../auth/device-credentials.js";
import type { WSMessage } from "../types.js";

/**
 * Send authentication or registration message to the server.
 *
 * If DOTBOT_INVITE_TOKEN is set while device.json already exists,
 * the user wants to re-register: delete old credentials and use the new token.
 */
export function authenticate(send: (msg: WSMessage) => void): void {
  const capabilities = ["powershell", "file_read", "file_write", "schema_extract", "memory", "skills"];

  // Detect platform for V2 tool filtering
  const nodePlatform = process.platform;
  const platform = nodePlatform === "win32" ? "windows"
    : nodePlatform === "darwin" ? "macos"
    : "linux";

  // If a new invite token is present, it takes priority over existing credentials.
  // This lets users re-register by simply setting DOTBOT_INVITE_TOKEN without
  // having to manually delete ~/.bot/device.json.
  const inviteToken = process.env.DOTBOT_INVITE_TOKEN;
  if (inviteToken && deviceCredentials) {
    console.log("[Agent] New invite token detected — replacing existing device credentials...");
    deleteDeviceCredentials();
    setDeviceCredentials(null);
  }

  if (deviceCredentials) {
    // Existing device — authenticate with stored credentials
    send({
      type: "auth",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        deviceId: deviceCredentials.deviceId,
        deviceSecret: deviceCredentials.deviceSecret,
        deviceName: DEVICE_NAME,
        capabilities,
        tempDir: TEMP_DIR,
        hwFingerprint,
        platform,
        version: AGENT_VERSION,
      },
    });
  } else {
    // New device — register with invite token
    if (!inviteToken) {
      console.error("[Agent] No device credentials found and no DOTBOT_INVITE_TOKEN set.");
      console.error("[Agent] Set DOTBOT_INVITE_TOKEN in ~/.bot/.env or environment to register this device.");
      process.exit(1);
    }
    console.log("[Agent] No device credentials found — registering with invite token...");
    send({
      type: "register_device",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        inviteToken,
        label: DEVICE_NAME,
        hwFingerprint,
        capabilities,
        tempDir: TEMP_DIR,
        platform,
        version: AGENT_VERSION,
      },
    });
  }
}
