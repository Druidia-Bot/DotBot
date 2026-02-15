/**
 * Authentication — Device registration and auth message construction.
 *
 * Builds and sends the auth or register_device message to the server.
 */

import { nanoid } from "nanoid";
import { TEMP_DIR } from "../memory/store-core.js";
import { DEVICE_NAME, deviceCredentials, hwFingerprint, SERVER_URL } from "./config.js";
import type { WSMessage } from "../types.js";

/**
 * Send authentication or registration message to the server.
 */
export function authenticate(send: (msg: WSMessage) => void): void {
  const capabilities = ["powershell", "file_read", "file_write", "schema_extract", "memory", "skills"];

  // Detect platform for V2 tool filtering
  const nodePlatform = process.platform;
  const platform = nodePlatform === "win32" ? "windows"
    : nodePlatform === "darwin" ? "macos"
    : "linux";

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
      },
    });
  } else {
    // New device — register with invite token
    const inviteToken = process.env.DOTBOT_INVITE_TOKEN;
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
      },
    });
  }
}
