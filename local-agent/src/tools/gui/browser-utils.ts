/**
 * Browser Utility Functions
 * 
 * Shared helpers used by the headless browser bridge and related modules:
 * - URL sanitization and validation
 * - Bot challenge detection (Cloudflare, hCaptcha, etc.)
 * - Default browser detection (Windows registry)
 * - System browser fallback (open URL in user's browser)
 * - Bot challenge result construction
 * - Timeout clamping
 */

import { promisify } from "util";
import type { Page } from "playwright";

// ============================================
// CONSTANTS
// ============================================

/** Maximum allowed timeout for wait operations (2 minutes) */
export const MAX_WAIT_TIMEOUT_MS = 120_000;

/** Allowed URL schemes for navigation */
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

// ============================================
// URL SANITIZATION
// ============================================

/**
 * Sanitize and validate a URL for navigation.
 * Blocks dangerous schemes (javascript:, file:, data:, etc.).
 * Auto-prepends https:// if no scheme is present.
 */
export function sanitizeUrl(raw: string): { url: string; error?: string } {
  // Auto-prepend https:// if no scheme
  const withScheme = raw.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:/) ? raw : `https://${raw}`;

  try {
    const parsed = new URL(withScheme);
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
      return { url: "", error: `Blocked URL scheme: ${parsed.protocol} — only http: and https: are allowed` };
    }
    return { url: parsed.href };
  } catch {
    return { url: "", error: `Invalid URL: ${raw}` };
  }
}

/** Clamp a timeout value to a safe range */
export function clampTimeout(value: any, defaultMs: number): number {
  const num = typeof value === "number" && !Number.isNaN(value) ? value : defaultMs;
  return Math.max(100, Math.min(num, MAX_WAIT_TIMEOUT_MS));
}

// ============================================
// BOT CHALLENGE DETECTION
// ============================================

/** Titles and content markers that indicate a bot/CAPTCHA challenge page */
const CHALLENGE_TITLE_PATTERNS = [
  "just a moment",
  "attention required",
  "checking your browser",
  "verify you are human",
  "one more step",
  "please wait",
  "access denied",
  "ddos protection",
];

const CHALLENGE_BODY_MARKERS = [
  "cf-browser-verification",
  "challenge-platform",
  "challenge-form",
  "hcaptcha",
  "g-recaptcha",
  "turnstile",
  "ray id",
];

/**
 * Detect if the current page is a bot challenge (Cloudflare, hCaptcha, etc.).
 * Returns the challenge type if detected, or null if the page looks normal.
 */
export async function detectBotChallenge(page: Page): Promise<string | null> {
  try {
    const title = (await page.title()).toLowerCase();
    for (const pattern of CHALLENGE_TITLE_PATTERNS) {
      if (title.includes(pattern)) {
        return `title_match:${pattern}`;
      }
    }

    // Check body content for challenge markers (fast — just innerHTML search)
    const bodySnippet = await page.evaluate(() => {
      const body = document.body;
      return body ? body.innerHTML.substring(0, 5000).toLowerCase() : "";
    });
    for (const marker of CHALLENGE_BODY_MARKERS) {
      if (bodySnippet.includes(marker)) {
        return `body_match:${marker}`;
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================
// DEFAULT BROWSER DETECTION
// ============================================

/** Map Windows ProgId to a human-friendly app name for desktop GUI targeting */
const PROGID_TO_APP_NAME: Record<string, string> = {
  "chromehtml": "Google Chrome",
  "msedgehtm": "Microsoft Edge",
  "firefoxurl": "Firefox",
  "firefoxurl-308046b0af4a39cb": "Firefox",
  "operastable": "Opera",
  "bravelhtml": "Brave",
  "vivaldihtm": "Vivaldi",
};

/**
 * Detect the user's default browser via the Windows registry.
 * Returns the app name (e.g., "Google Chrome", "Microsoft Edge") or null.
 */
export async function detectDefaultBrowser(): Promise<string | null> {
  try {
    const { execFile: execFileCb } = await import("child_process");
    const execFileP = promisify(execFileCb);
    const { stdout } = await execFileP("reg", [
      "query",
      "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice",
      "/v", "ProgId",
    ], { timeout: 5_000 });
    // Output format: "    ProgId    REG_SZ    ChromeHTML"
    const match = stdout.match(/ProgId\s+REG_SZ\s+(\S+)/i);
    if (match) {
      const progId = match[1].toLowerCase();
      return PROGID_TO_APP_NAME[progId] || null;
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================
// SYSTEM BROWSER FALLBACK
// ============================================

/**
 * Open a URL in the user's system browser (not headless).
 * Used as fallback when bot challenges block headless navigation.
 * Returns { opened, browserName } — browserName helps the agent target the right window.
 */
export async function openInSystemBrowser(url: string): Promise<{ opened: boolean; browserName: string | null }> {
  const browserName = await detectDefaultBrowser();
  try {
    const { execFile: execFileCb } = await import("child_process");
    const execFileP = promisify(execFileCb);
    await execFileP("cmd", ["/c", "start", "", url], { timeout: 10_000 });
    // Wait for the browser window to appear before returning
    await new Promise(resolve => setTimeout(resolve, 3000));
    return { opened: true, browserName };
  } catch {
    return { opened: false, browserName };
  }
}

// ============================================
// BOT CHALLENGE RESULT
// ============================================

/**
 * Build a consistent bot challenge result object.
 * Includes the detected default browser name so the agent knows exactly which window to target,
 * and carries the original intent so the agent doesn't lose track of what it was doing.
 */
export function buildBotChallengeResult(
  url: string,
  challenge: string,
  opened: boolean,
  browserName: string | null,
  pendingAction?: string,
): Record<string, any> {
  const appName = browserName || "Google Chrome";
  const appNameArg = `app_name='${appName}'`;

  // Build step-by-step instructions so the agent doesn't get stuck
  const steps = [
    `1. gui.read_state(${appNameArg}) — see what's on screen`,
    `2. If a Cloudflare checkbox is visible, gui.click(${appNameArg}, element_text='Verify you are human') or click the checkbox`,
    `3. gui.wait_for(${appNameArg}, condition='page_load', target='${new URL(url).hostname}', timeout_ms=10000)`,
  ];
  if (pendingAction) {
    steps.push(`4. ${pendingAction}`);
  }

  return {
    navigated: false,
    url,
    bot_challenge: true,
    challenge_type: challenge,
    fallback: opened ? "system_browser" : "none",
    browser_app_name: appName,
    pending_action: pendingAction || null,
    hint: opened
      ? [
          `Bot challenge detected. URL already open in ${appName}.`,
          `DO NOT call gui.navigate again — the page is already loaded.`,
          `Switch to desktop GUI track with ${appNameArg} for ALL subsequent calls.`,
          `Next steps:`,
          ...steps,
        ].join("\n")
      : "Bot challenge detected. Could not open system browser. Try gui.navigate with app_name to open in a desktop browser.",
  };
}
