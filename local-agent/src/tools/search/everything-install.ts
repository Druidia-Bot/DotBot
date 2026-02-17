/**
 * Everything Search auto-install logic.
 * Downloads es.exe CLI and ensures the Everything service is running.
 */

import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";

const BOT_BIN_DIR = join(homedir(), ".bot", "bin");
export const BOT_ES_PATH = join(BOT_BIN_DIR, "es.exe");

const ES_CLI_URL = "https://www.voidtools.com/ES-1.1.0.30.x64.zip";

/**
 * Attempt to auto-install Everything Search + es.exe CLI.
 * 1. Download es.exe CLI to ~/.bot/bin/
 * 2. Check if Everything is running; if not, try winget install
 * Returns the path to es.exe on success, null on failure.
 */
export async function ensureEverythingSearch(): Promise<string | null> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  console.log("[search.files] es.exe not found — attempting auto-install...");

  // Step 1: Download es.exe CLI to ~/.bot/bin/
  if (!existsSync(BOT_ES_PATH)) {
    try {
      mkdirSync(BOT_BIN_DIR, { recursive: true });
      const psScript = [
        "$ErrorActionPreference = 'Stop'",
        `$zipUrl = '${ES_CLI_URL}'`,
        "$zipPath = Join-Path $env:TEMP 'dotbot_es_cli.zip'",
        `$destDir = '${BOT_BIN_DIR.replace(/\\/g, "\\\\")}'`,
        "Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing",
        "Expand-Archive -Path $zipPath -DestinationPath $destDir -Force",
        "Remove-Item $zipPath -Force",
      ].join("; ");

      await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", psScript], {
        timeout: 60_000,
        windowsHide: true,
      });
      console.log("[search.files] es.exe downloaded to", BOT_BIN_DIR);
    } catch (err: any) {
      console.error("[search.files] Failed to download es.exe:", err.message || err);
      return null;
    }
  }

  if (!existsSync(BOT_ES_PATH)) {
    console.error("[search.files] es.exe not found after download attempt");
    return null;
  }

  // Step 2: Check if Everything is running
  let everythingRunning = false;
  try {
    const { stdout } = await execFileAsync("tasklist", ["/FI", "IMAGENAME eq Everything.exe", "/NH"], {
      timeout: 5_000,
      windowsHide: true,
    });
    everythingRunning = stdout.toLowerCase().includes("everything.exe");
  } catch {
    // tasklist failed — can't determine
  }

  if (!everythingRunning) {
    console.log("[search.files] Everything not running — attempting winget install...");
    try {
      await execFileAsync("winget", [
        "install", "voidtools.Everything",
        "--accept-package-agreements", "--accept-source-agreements",
        "--silent",
      ], { timeout: 120_000, windowsHide: true });
      console.log("[search.files] Everything installed via winget");
      // Give the service a moment to start and begin indexing
      await new Promise(r => setTimeout(r, 3_000));
    } catch (err: any) {
      console.error("[search.files] winget install failed:", err.message || err);

      // Try starting Everything if it was already installed but not running
      const everythingPaths = [
        "C:\\Program Files\\Everything\\Everything.exe",
        "C:\\Program Files (x86)\\Everything\\Everything.exe",
      ];
      for (const p of everythingPaths) {
        if (existsSync(p)) {
          try {
            await execFileAsync(p, ["-startup"], { timeout: 5_000, windowsHide: true });
            console.log("[search.files] Started Everything from", p);
            await new Promise(r => setTimeout(r, 2_000));
            everythingRunning = true;
            break;
          } catch { /* ignore */ }
        }
      }

      if (!everythingRunning) {
        console.error("[search.files] Everything is not installed and could not be auto-installed");
        return null;
      }
    }
  }

  return BOT_ES_PATH;
}
