/**
 * Auto-Update Checker — Periodic task that checks for new DotBot versions
 * 
 * Runs `git fetch --dry-run` to see if the remote has new commits.
 * Notifies via Discord #updates if an update is available.
 */

import { execSync } from "child_process";
import type { PeriodicTaskDef } from "../periodic/index.js";

const INSTALL_DIR = process.env.DOTBOT_INSTALL_DIR || "C:\\Program Files\\.bot";

let notifyCallback: ((message: string) => void) | null = null;
let lastNotifiedAt: number = 0;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function setUpdateNotifyCallback(cb: (message: string) => void): void {
  notifyCallback = cb;
}

/**
 * Check if updates are available via git fetch --dry-run.
 * Called by the periodic task manager.
 */
export async function checkForUpdates(): Promise<void> {
  // Don't notify more than once per day
  if (Date.now() - lastNotifiedAt < ONE_DAY_MS) return;

  try {
    // Check if it's a git repo
    execSync(`git rev-parse --git-dir`, { cwd: INSTALL_DIR, timeout: 5_000, stdio: "pipe" });

    // Fetch latest refs without downloading objects
    const fetchOutput = execSync(`git fetch --dry-run 2>&1`, {
      cwd: INSTALL_DIR,
      timeout: 15_000,
      encoding: "utf-8",
      stdio: "pipe",
    });

    // If fetch --dry-run produces output, there are new commits
    if (fetchOutput.trim().length > 0) {
      lastNotifiedAt = Date.now();
      if (notifyCallback) {
        notifyCallback(
          `A DotBot update is available! Say "update yourself" or run \`system.update\` to install it.`
        );
      }
      console.log("[Update] New version available on remote");
    }
  } catch {
    // Not a git repo, no network, or git not installed — silently skip
  }
}

export function canCheckForUpdates(): boolean {
  return true;
}

/**
 * Returns the periodic task definition for the update checker.
 * Config is co-located here; post-auth-init just collects it.
 */
export function getPeriodicTaskDef(): PeriodicTaskDef {
  return {
    id: "update-check",
    name: "Update Check",
    intervalMs: 6 * 60 * 60 * 1000, // Check every 6 hours
    initialDelayMs: 10 * 60 * 1000, // 10 minutes after startup
    enabled: true,
    run: () => checkForUpdates(),
    canRun: canCheckForUpdates,
  };
}
