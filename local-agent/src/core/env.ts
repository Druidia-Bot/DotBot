/**
 * Environment Loading — ~/.bot/.env parser
 *
 * Loads key=value pairs from ~/.bot/.env into process.env at startup.
 * Handles UTF-8 BOM from PowerShell, respects existing env vars.
 */

import { readFileSync, writeFileSync } from "fs";
import path from "path";

const ENV_PATH = path.resolve(
  process.env.USERPROFILE || process.env.HOME || "",
  ".bot",
  ".env",
);

/**
 * Load ~/.bot/.env into process.env. Existing env vars take precedence.
 * Call once at module load time (top of index.ts).
 */
export function loadBotEnv(): void {
  try {
    let content = readFileSync(ENV_PATH, "utf-8");
    // Strip UTF-8 BOM — PowerShell 5.1 Set-Content -Encoding UTF8 always adds one
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.substring(0, eqIdx).trim();
        const value = trimmed.substring(eqIdx + 1).trim();
        // Don't overwrite existing env vars (CLI/system take precedence)
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  } catch {
    // ~/.bot/.env doesn't exist yet — that's fine
  }
}

/**
 * Remove consumed invite token from ~/.bot/.env after successful registration.
 */
export function cleanConsumedInviteToken(): void {
  try {
    let content = readFileSync(ENV_PATH, "utf-8");
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
    const filtered = content
      .split(/\r?\n/)
      .filter(line => !line.trim().startsWith("DOTBOT_INVITE_TOKEN="))
      .join("\n");
    if (filtered !== content) {
      writeFileSync(ENV_PATH, filtered, "utf-8");
      console.log("[Agent] Removed consumed invite token from .env");
    }
  } catch {
    // .env doesn't exist or can't be written — not critical
  }
}
