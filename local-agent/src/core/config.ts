/**
 * Configuration — Server URL normalization and device constants.
 *
 * Pure functions + exported constants. No shared mutable state.
 */

import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { loadDeviceCredentials } from "../auth/device-credentials.js";
import { collectHardwareFingerprint } from "../auth/hw-fingerprint.js";

// ============================================
// SERVER URL
// ============================================

export function normalizeServerUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, ""); // trim + strip trailing slashes

  // Detect corrupted .env (missing newlines between keys)
  if (url.includes("DOTBOT_") || url.includes("=")) {
    console.error("[Agent] FATAL: DOTBOT_SERVER value is corrupted (contains other .env keys).");
    console.error(`[Agent]   Raw value: ${url.slice(0, 120)}`);
    console.error("[Agent]   Fix: delete ~/.bot/.env and re-run the installer, or manually edit the file");
    console.error("[Agent]   Each key=value pair must be on its own line.");
    process.exit(1);
  }

  // Fix scheme: https:// → wss://, http:// → ws://
  if (url.startsWith("https://")) url = "wss://" + url.slice(8);
  else if (url.startsWith("http://")) url = "ws://" + url.slice(7);

  // No scheme at all → add wss:// for domains, ws:// for localhost
  if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
    const isLocal = /^(localhost|127\.0\.0\.1)(:|$)/.test(url);
    url = (isLocal ? "ws://" : "wss://") + url;
  }

  // Remote servers (not localhost) need /ws path for Caddy routing
  const isLocalhost = /^wss?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url);
  if (!isLocalhost && !url.endsWith("/ws")) {
    url = url + "/ws";
  }

  return url;
}

function autoCorrectServerUrl(): string {
  const raw = process.env.DOTBOT_SERVER || "ws://localhost:3001";
  const corrected = normalizeServerUrl(raw);

  if (corrected !== raw && process.env.DOTBOT_SERVER) {
    console.log(`[Agent] Auto-corrected server URL:`);
    console.log(`[Agent]   was: ${raw}`);
    console.log(`[Agent]   now: ${corrected}`);

    // Update ~/.bot/.env so the fix persists
    const envPath = path.resolve(process.env.USERPROFILE || process.env.HOME || "", ".bot", ".env");
    try {
      let content = readFileSync(envPath, "utf-8");
      if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
      const updated = content
        .split(/\r?\n/)
        .map(line => line.trim().startsWith("DOTBOT_SERVER=") ? `DOTBOT_SERVER=${corrected}` : line)
        .join("\n");
      if (updated !== content) {
        writeFileSync(envPath, updated, "utf-8");
        console.log("[Agent] Updated ~/.bot/.env with corrected URL");
      }
    } catch {
      // Can't update .env — not critical, the in-memory value is fixed
    }

    process.env.DOTBOT_SERVER = corrected;
  }

  return corrected;
}

// ============================================
// EXPORTED CONSTANTS (computed once at import time)
// ============================================

export const SERVER_URL = autoCorrectServerUrl();
export const DEVICE_NAME = process.env.DEVICE_NAME || `Windows-${process.env.COMPUTERNAME || "PC"}`;

// Device credentials (loaded from ~/.bot/device.json after registration)
export let deviceCredentials = loadDeviceCredentials();

export function setDeviceCredentials(creds: ReturnType<typeof loadDeviceCredentials>): void {
  deviceCredentials = creds;
}

// Hardware fingerprint — computed once at startup, held in memory only.
// NEVER exposed to LLM context or any tool.
export let hwFingerprint: string = "";
try {
  hwFingerprint = collectHardwareFingerprint();
  console.log("[Agent] Hardware fingerprint computed");
} catch (err) {
  console.error("[Agent] Failed to compute hardware fingerprint:", err);
  process.exit(1);
}
