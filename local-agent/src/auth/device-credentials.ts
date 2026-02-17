/**
 * Device Credentials
 * 
 * Manages the local device.json file that stores the device ID, secret,
 * and server URL after registration. This file is loaded at startup
 * and used for WebSocket authentication.
 * 
 * Stored at ~/.bot/device.json — NEVER exposed to LLM or tools.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const BOT_DIR = path.join(os.homedir(), ".bot");
const DEVICE_FILE = path.join(BOT_DIR, "device.json");

export interface DeviceCredentials {
  deviceId: string;
  deviceSecret: string;
  serverUrl: string;
  registeredAt: string;
  label: string;
}

export function loadDeviceCredentials(): DeviceCredentials | null {
  if (!fs.existsSync(DEVICE_FILE)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(DEVICE_FILE, "utf-8");
    return JSON.parse(raw) as DeviceCredentials;
  } catch {
    return null;
  }
}

export function saveDeviceCredentials(creds: DeviceCredentials): void {
  if (!fs.existsSync(BOT_DIR)) {
    fs.mkdirSync(BOT_DIR, { recursive: true });
  }
  fs.writeFileSync(DEVICE_FILE, JSON.stringify(creds, null, 2), "utf-8");
}

export function hasDeviceCredentials(): boolean {
  return fs.existsSync(DEVICE_FILE);
}

export function deleteDeviceCredentials(): void {
  try {
    if (fs.existsSync(DEVICE_FILE)) {
      fs.unlinkSync(DEVICE_FILE);
    }
  } catch {
    // non-fatal — file may already be gone
  }
}
