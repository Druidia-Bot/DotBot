/**
 * Playwright Browser Auto-Installer
 * 
 * Checks if Chromium is installed for Playwright and automatically
 * installs it if missing. Called during local agent startup.
 * 
 * Non-fatal: if the install fails, the agent continues — gui.* tools
 * will just fail at runtime with a clear error message.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);

/**
 * Check if Playwright's Chromium browser is installed.
 * Attempts to resolve the executable path — if it throws, not installed.
 */
async function isChromiumInstalled(): Promise<boolean> {
  try {
    // Playwright exposes executablePath() which throws if browser not found
    const path = chromium.executablePath();
    // Also verify the file actually exists
    const { promises: fs } = await import("fs");
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure Playwright Chromium is installed. If not, runs
 * `npx playwright install chromium` automatically.
 * 
 * Returns:
 * - "already_installed" — browser was already present
 * - "installed" — browser was just installed
 * - "failed" — install attempted but failed (non-fatal)
 */
export async function ensurePlaywrightBrowser(): Promise<"already_installed" | "installed" | "failed"> {
  const installed = await isChromiumInstalled();
  if (installed) {
    console.log("[GUI] Playwright Chromium: ready");
    return "already_installed";
  }

  console.log("[GUI] Playwright Chromium not found — installing automatically...");

  try {
    const { stdout, stderr } = await execFileAsync("npx", ["playwright", "install", "chromium"], {
      timeout: 300_000, // 5 min — download can be slow
      shell: true,
    });

    if (stdout) console.log(stdout.trim());

    // Verify it actually installed
    const nowInstalled = await isChromiumInstalled();
    if (nowInstalled) {
      console.log("[GUI] Playwright Chromium: installed successfully");
      return "installed";
    } else {
      console.warn("[GUI] Playwright Chromium: install command ran but browser not found");
      if (stderr) console.warn(stderr.trim());
      return "failed";
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[GUI] Playwright Chromium install failed (non-fatal): ${msg}`);
    console.warn("[GUI] GUI automation tools will be unavailable. Run 'npx playwright install chromium' manually.");
    return "failed";
  }
}
