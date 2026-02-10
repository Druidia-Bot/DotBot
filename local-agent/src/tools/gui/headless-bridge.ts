/**
 * Headless Browser Bridge
 * 
 * Manages a headless Chromium instance via Playwright for browser automation.
 * The browser launches lazily on first gui.* tool call and stays alive for
 * the agent's lifetime. Persistent context at ~/.bot/browser-data/ preserves
 * cookies, localStorage, and login sessions across restarts.
 * 
 * Key design decisions:
 * - launchPersistentContext (not launch + newContext) so logins survive restarts
 * - headless: true (no visible window, zero interference with user's desktop)
 * - Network-level ad blocking via context.route() (Layer 1)
 * - uBlock Origin extension for cosmetic filtering (Layer 2, when available)
 * - Viewport locked at 1280×720 for consistent screenshots
 */

import { chromium, type BrowserContext, type Page } from "playwright";
import { promises as fs } from "fs";
import { join } from "path";
import os from "os";
import { promisify } from "util";
import { applyNetworkBlocklist } from "./adblock.js";
import { networkInterceptor } from "./network-interceptor.js";
import {
  sanitizeUrl,
  clampTimeout,
  detectBotChallenge,
  openInSystemBrowser,
  buildBotChallengeResult,
} from "./browser-utils.js";
import { searchWebsite, fillAndSubmit } from "./compound-actions.js";
import {
  findElement,
  readStateVisual,
  clickSoMElement,
} from "./visual-grounding.js";

// ============================================
// PATHS
// ============================================

const BOT_DIR = join(os.homedir(), ".bot");
const BROWSER_DATA_DIR = join(BOT_DIR, "browser-data");
const UBLOCK_PATH = join(BOT_DIR, "extensions", "ublock");

// ============================================
// HEADLESS BROWSER BRIDGE
// ============================================

export class HeadlessBrowserBridge {
  private context: BrowserContext | null = null;
  private launching: Promise<void> | null = null;

  /**
   * Lazy-launch the headless browser. Subsequent calls are no-ops.
   * Uses a launch guard to prevent concurrent launch attempts.
   */
  async ensureLaunched(): Promise<void> {
    if (this.context) return;
    if (this.launching) {
      await this.launching;
      return;
    }

    this.launching = this._launch();
    try {
      await this.launching;
    } finally {
      this.launching = null;
    }
  }

  private async _launch(): Promise<void> {
    // Ensure browser data directory exists
    await fs.mkdir(BROWSER_DATA_DIR, { recursive: true });

    // Detect if uBlock Origin is available
    const hasUblock = await this._checkUblockAvailable();

    const launchArgs: string[] = [];
    if (hasUblock) {
      launchArgs.push(
        `--disable-extensions-except=${UBLOCK_PATH}`,
        `--load-extension=${UBLOCK_PATH}`,
      );
    }

    console.log(`[HeadlessBridge] Launching headless Chromium (uBlock: ${hasUblock ? "yes" : "no"})...`);

    this.context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
      headless: true,
      args: launchArgs,
      viewport: { width: 1280, height: 720 },
      locale: "en-US",
      timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
      // Stealth basics — reduce headless detection fingerprint
      bypassCSP: false,
      ignoreHTTPSErrors: false,
    });

    // Layer 1: network-level ad/tracker blocking
    await applyNetworkBlocklist(this.context, BROWSER_DATA_DIR);

    // Handle unexpected page closures
    this.context.on("close", () => {
      console.log("[HeadlessBridge] Browser context closed");
      this.context = null;
    });

    const pages = this.context.pages();
    console.log(`[HeadlessBridge] Launched. ${pages.length} existing page(s).`);
  }

  private async _checkUblockAvailable(): Promise<boolean> {
    try {
      await fs.access(join(UBLOCK_PATH, "manifest.json"));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the "active" page — the last page in the context, or create one.
   */
  async getActivePage(): Promise<Page> {
    await this.ensureLaunched();
    const pages = this.context!.pages();
    return pages[pages.length - 1] || await this.context!.newPage();
  }

  /**
   * Get the browser context (for multi-page operations).
   */
  async getContext(): Promise<BrowserContext> {
    await this.ensureLaunched();
    return this.context!;
  }

  /** Whether the browser is currently launched. */
  get isLaunched(): boolean {
    return this.context !== null;
  }

  // ============================================
  // TOOL IMPLEMENTATIONS
  // ============================================

  /**
   * gui.read_state — Read the current page state via accessibility snapshot.
   * Returns a structured text representation of the page.
   */
  async readState(args: Record<string, any>): Promise<string> {
    const page = await this.getActivePage();

    // If a URL was provided and the page is blank, navigate first
    if (args.url && (page.url() === "about:blank" || page.url() === "")) {
      const { url: safeUrl, error } = sanitizeUrl(args.url);
      if (error) return JSON.stringify({ error });
      await page.goto(safeUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

      // Check for bot challenges after navigation
      const challenge = await detectBotChallenge(page);
      if (challenge) {
        const { opened, browserName } = await openInSystemBrowser(safeUrl);
        return JSON.stringify(buildBotChallengeResult(safeUrl, challenge, opened, browserName));
      }
    }

    // Use modern ariaSnapshot() — returns a structured ARIA text representation
    const snapshot = await page.locator("body").ariaSnapshot();
    const url = page.url();
    const title = await page.title();

    // Get all open tabs
    const context = await this.getContext();
    const tabList: { index: number; url: string }[] = [];
    for (const [i, p] of context.pages().entries()) {
      tabList.push({ index: i, url: p.url() });
    }

    return JSON.stringify({
      url,
      title,
      tab_count: tabList.length,
      tabs: tabList,
      aria_snapshot: snapshot,
    }, null, 2);
  }

  /**
   * gui.click — Click an element by text content, CSS selector, or locator.
   */
  async click(args: Record<string, any>): Promise<string> {
    const page = await this.getActivePage();

    if (args.coordinates) {
      await page.mouse.click(args.coordinates.x, args.coordinates.y);
      return JSON.stringify({ clicked: true, method: "coordinates", x: args.coordinates.x, y: args.coordinates.y });
    }

    if (!args.element_text) {
      return JSON.stringify({ clicked: false, error: "No element_text or coordinates provided" });
    }

    const clickType = args.click_type || "single";
    const locator = page.getByText(args.element_text, { exact: false }).first();

    try {
      await locator.waitFor({ state: "visible", timeout: 5_000 });

      if (clickType === "double") {
        await locator.dblclick({ timeout: 5_000 });
      } else if (clickType === "right") {
        await locator.click({ button: "right", timeout: 5_000 });
      } else {
        await locator.click({ timeout: 5_000 });
      }

      return JSON.stringify({ clicked: true, method: "text_locator", element_text: args.element_text, click_type: clickType });
    } catch (err) {
      // Fallback: try role-based locator
      try {
        const roleLocator = page.getByRole("button", { name: args.element_text }).or(
          page.getByRole("link", { name: args.element_text })
        ).or(
          page.getByRole("tab", { name: args.element_text })
        ).or(
          page.getByRole("menuitem", { name: args.element_text })
        ).first();

        await roleLocator.click({ timeout: 5_000 });
        return JSON.stringify({ clicked: true, method: "role_locator", element_text: args.element_text, click_type: clickType });
      } catch {
        return JSON.stringify({
          clicked: false,
          error: `Element "${args.element_text}" not found or not clickable`,
          page_url: page.url(),
          page_title: await page.title(),
        });
      }
    }
  }

  /**
   * gui.type_text — Type text into the focused element or a specified target.
   */
  async typeText(args: Record<string, any>): Promise<string> {
    const page = await this.getActivePage();

    // Click target element first if specified
    if (args.target_element) {
      const locator = page.getByPlaceholder(args.target_element).or(
        page.getByLabel(args.target_element)
      ).or(
        page.getByRole("textbox", { name: args.target_element })
      ).or(
        page.getByText(args.target_element)
      ).first();

      try {
        await locator.click({ timeout: 5_000 });
      } catch {
        return JSON.stringify({ typed: false, error: `Target element "${args.target_element}" not found` });
      }
    }

    // Use fill() when targeting a specific element (replaces existing content),
    // keyboard.type() when typing into whatever is focused (appends).
    if (args.target_element) {
      // We already clicked the target above — now fill it
      const fillLocator = page.getByPlaceholder(args.target_element).or(
        page.getByLabel(args.target_element)
      ).or(
        page.getByRole("textbox", { name: args.target_element })
      ).first();

      try {
        await fillLocator.fill(args.text || "", { timeout: 5_000 });
      } catch {
        // fill() failed (maybe not an input) — fall back to keyboard.type()
        await page.keyboard.type(args.text || "", { delay: 10 });
      }
    } else {
      await page.keyboard.type(args.text || "", { delay: 10 });
    }

    if (args.press_enter) {
      await page.keyboard.press("Enter");
    }

    return JSON.stringify({ typed: true, text_length: (args.text || "").length, press_enter: !!args.press_enter });
  }

  /**
   * gui.hotkey — Send keyboard shortcuts.
   */
  async hotkey(args: Record<string, any>): Promise<string> {
    const page = await this.getActivePage();
    const keys = args.keys as string;

    if (!keys) {
      return JSON.stringify({ sent: false, error: "No keys specified" });
    }

    // Parse combo: "ctrl+t" → ["Control", "t"]
    const parts = keys.split("+").map(k => {
      const lower = k.trim().toLowerCase();
      switch (lower) {
        case "ctrl":
        case "control": return "Control";
        case "alt": return "Alt";
        case "shift": return "Shift";
        case "meta":
        case "win":
        case "cmd": return "Meta";
        case "enter":
        case "return": return "Enter";
        case "tab": return "Tab";
        case "esc":
        case "escape": return "Escape";
        case "backspace": return "Backspace";
        case "delete":
        case "del": return "Delete";
        case "space": return " ";
        case "up": return "ArrowUp";
        case "down": return "ArrowDown";
        case "left": return "ArrowLeft";
        case "right": return "ArrowRight";
        case "home": return "Home";
        case "end": return "End";
        case "pageup": return "PageUp";
        case "pagedown": return "PageDown";
        default: return k.trim();
      }
    });

    // Use Playwright's keyboard shortcut syntax: "Control+KeyT"
    const combo = parts.join("+");
    await page.keyboard.press(combo);

    return JSON.stringify({ sent: true, keys: combo });
  }

  /**
   * gui.switch_tab — Switch to a tab matching title or URL.
   */
  async switchTab(args: Record<string, any>): Promise<string> {
    const context = await this.getContext();
    const pages = context.pages();
    const match = (args.title_match || "").toLowerCase();

    for (const p of pages) {
      const title = await p.title();
      const url = p.url();
      if (title.toLowerCase().includes(match) || url.toLowerCase().includes(match)) {
        await p.bringToFront();
        return JSON.stringify({ switched: true, url, title, tab_count: pages.length });
      }
    }

    // Return available tabs for the LLM to choose from
    const available = [];
    for (const p of pages) {
      available.push({ url: p.url(), title: await p.title() });
    }
    return JSON.stringify({ switched: false, error: `No tab matching "${args.title_match}"`, available_tabs: available });
  }

  /**
   * gui.wait_for — Wait for a condition (element visible, URL change, etc.)
   */
  async waitFor(args: Record<string, any>): Promise<string> {
    const page = await this.getActivePage();
    const timeout = clampTimeout(args.timeout_ms, 10_000);
    const condition = args.condition as string;
    const target = args.target as string;

    try {
      switch (condition) {
        case "element_visible":
          await page.getByText(target, { exact: false }).first().waitFor({ state: "visible", timeout });
          return JSON.stringify({ waited: true, condition, target });

        case "element_gone":
          await page.getByText(target, { exact: false }).first().waitFor({ state: "hidden", timeout });
          return JSON.stringify({ waited: true, condition, target });

        case "window_title_contains":
          await page.waitForFunction(
            (t: string) => document.title.toLowerCase().includes(t.toLowerCase()),
            target,
            { timeout }
          );
          return JSON.stringify({ waited: true, condition, target, current_title: await page.title() });

        case "window_exists":
          // In headless context, "window" = a page with matching title/URL
          const ctx = await this.getContext();
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) {
            for (const p of ctx.pages()) {
              const title = await p.title();
              if (title.toLowerCase().includes(target.toLowerCase()) || p.url().toLowerCase().includes(target.toLowerCase())) {
                return JSON.stringify({ waited: true, condition, target, url: p.url() });
              }
            }
            await new Promise(r => setTimeout(r, 250));
          }
          return JSON.stringify({ waited: false, condition, target, error: "Timeout waiting for matching page" });

        case "url_contains":
          await page.waitForURL(`**/*${target}*`, { timeout });
          return JSON.stringify({ waited: true, condition, target, current_url: page.url() });

        case "page_load":
          await page.waitForLoadState("domcontentloaded", { timeout });
          return JSON.stringify({ waited: true, condition, url: page.url() });

        default:
          return JSON.stringify({ waited: false, error: `Unknown condition: ${condition}` });
      }
    } catch (err) {
      return JSON.stringify({
        waited: false,
        condition,
        target,
        error: `Timeout after ${timeout}ms waiting for ${condition}: ${target}`,
        current_url: page.url(),
        current_title: await page.title(),
      });
    }
  }

  /**
   * gui.navigate — Navigate to a URL.
   */
  async navigate(args: Record<string, any>): Promise<string> {
    const page = await this.getActivePage();
    const url = args.url as string;

    if (!url) {
      return JSON.stringify({ navigated: false, error: "No url provided" });
    }

    // Validate and sanitize URL
    const { url: fullUrl, error: urlError } = sanitizeUrl(url);
    if (urlError) {
      return JSON.stringify({ navigated: false, url, error: urlError });
    }

    try {
      const response = await page.goto(fullUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });

      // Detect bot challenges (Cloudflare, hCaptcha, etc.)
      const challenge = await detectBotChallenge(page);
      if (challenge) {
        // Open in system browser so the user can pass the challenge
        const { opened, browserName } = await openInSystemBrowser(fullUrl);
        return JSON.stringify(buildBotChallengeResult(fullUrl, challenge, opened, browserName));
      }

      return JSON.stringify({
        navigated: true,
        url: page.url(),
        title: await page.title(),
        status: response?.status() || null,
      });
    } catch (err) {
      return JSON.stringify({
        navigated: false,
        url: fullUrl,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * gui.screenshot_region — Take a screenshot with JPEG compression and downscaling.
   */
  async screenshotRegion(args: Record<string, any>): Promise<string> {
    const page = await this.getActivePage();
    const quality = Math.max(1, Math.min(args.quality || 60, 100));
    const format = args.format === "png" ? "png" : "jpeg";
    const maxWidth = args.max_width || 1280;

    let clipRegion: { x: number; y: number; width: number; height: number } | undefined;

    // Parse region argument
    if (args.region && typeof args.region === "object" && "x" in args.region) {
      clipRegion = args.region;
    } else if (args.region && typeof args.region === "string") {
      const viewport = page.viewportSize() || { width: 1280, height: 720 };
      switch (args.region) {
        case "top_half":
          clipRegion = { x: 0, y: 0, width: viewport.width, height: Math.floor(viewport.height / 2) };
          break;
        case "bottom_half":
          clipRegion = { x: 0, y: Math.floor(viewport.height / 2), width: viewport.width, height: Math.floor(viewport.height / 2) };
          break;
        case "left_half":
          clipRegion = { x: 0, y: 0, width: Math.floor(viewport.width / 2), height: viewport.height };
          break;
        case "right_half":
          clipRegion = { x: Math.floor(viewport.width / 2), y: 0, width: Math.floor(viewport.width / 2), height: viewport.height };
          break;
        case "center":
          const cw = Math.min(400, viewport.width);
          const ch = Math.min(400, viewport.height);
          clipRegion = {
            x: Math.floor((viewport.width - cw) / 2),
            y: Math.floor((viewport.height - ch) / 2),
            width: cw,
            height: ch,
          };
          break;
        case "menu_bar":
          clipRegion = { x: 0, y: 0, width: viewport.width, height: 60 };
          break;
        case "sidebar":
          clipRegion = { x: 0, y: 0, width: 250, height: viewport.height };
          break;
        // "full" or unrecognized — no clip, capture entire viewport
      }
    }

    const screenshotOptions: any = {
      type: format,
      scale: "css" as const,
    };
    if (format === "jpeg") {
      screenshotOptions.quality = quality;
    }
    if (clipRegion) {
      screenshotOptions.clip = clipRegion;
    }

    const buffer = await page.screenshot(screenshotOptions);
    const base64 = buffer.toString("base64");

    // Calculate dimensions from clip region or viewport
    const viewport = page.viewportSize() || { width: 1280, height: 720 };
    const width = clipRegion ? clipRegion.width : viewport.width;
    const height = clipRegion ? clipRegion.height : viewport.height;

    return JSON.stringify({
      image_base64: base64,
      width,
      height,
      format,
      file_size_kb: Math.round(buffer.length / 1024),
      region_captured: args.region || "full",
      track: "headless",
    });
  }

  /**
   * gui.open_in_browser — Hand off the current page to a visible browser.
   */
  async openInBrowser(args: Record<string, any>): Promise<string> {
    const page = await this.getActivePage();
    const url = args.url || page.url();
    const mode = args.mode || "full_handoff";

    if (mode === "url_only") {
      // Validate URL before passing to shell
      const { url: safeUrl, error: urlError } = sanitizeUrl(url);
      if (urlError) {
        return JSON.stringify({ opened: false, error: urlError });
      }
      // Open URL in user's default browser (no session transfer)
      // Use execFile with args array to prevent command injection
      try {
        const { execFile: execFileCb } = await import("child_process");
        const execFileP = promisify(execFileCb);
        await execFileP("cmd", ["/c", "start", "", safeUrl], { timeout: 10_000 });
        return JSON.stringify({ opened: true, mode: "url_only", url: safeUrl, session_transferred: false });
      } catch (err) {
        return JSON.stringify({ opened: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Full handoff: close headless context, reopen as visible with same profile
    try {
      await this.context!.close();
      this.context = null;

      this.context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
        headless: false,
        viewport: null, // Use default window size
      });

      // Re-apply ad blocking on the visible context
      await applyNetworkBlocklist(this.context, BROWSER_DATA_DIR);

      const visiblePage = this.context.pages()[0] || await this.context.newPage();
      if (url && url !== "about:blank") {
        await visiblePage.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      }

      return JSON.stringify({ opened: true, mode: "full_handoff", url, session_transferred: true });
    } catch (err) {
      return JSON.stringify({ opened: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ============================================
  // COMPOUND TOOLS (delegated to compound-actions.ts)
  // ============================================

  async searchWebsite(args: Record<string, any>): Promise<string> {
    const page = await this.getActivePage();
    return searchWebsite(page, args);
  }

  async fillAndSubmit(args: Record<string, any>): Promise<string> {
    const page = await this.getActivePage();
    return fillAndSubmit(page, args);
  }

  // ============================================
  // VISUAL GROUNDING (delegated to visual-grounding.ts)
  // ============================================

  async findElement(args: Record<string, any>): Promise<string> {
    const page = await this.getActivePage();
    return findElement(page, args);
  }

  async readStateVisual(args: Record<string, any>): Promise<string> {
    const page = await this.getActivePage();
    const context = await this.getContext();
    return readStateVisual(page, context, args);
  }

  async clickSoMElement(page: Page, somId: number): Promise<string> {
    return clickSoMElement(page, somId);
  }

  // ============================================
  // PHASE 3: NETWORK INTERCEPTION
  // ============================================

  /**
   * gui.start_recording — Begin intercepting API traffic.
   */
  async startRecording(args: Record<string, any>): Promise<string> {
    const context = await this.getContext();
    return await networkInterceptor.startRecording(context, args.domain);
  }

  /**
   * gui.stop_recording — Stop intercepting and save learned schemas.
   */
  async stopRecording(_args: Record<string, any>): Promise<string> {
    const context = await this.getContext();
    return await networkInterceptor.stopRecording(context);
  }

  /**
   * gui.list_schemas — List all previously learned API schemas.
   */
  async listSchemas(_args: Record<string, any>): Promise<string> {
    return await networkInterceptor.listSchemas();
  }

  /**
   * gui.read_schema — Read a specific learned schema.
   */
  async readSchema(args: Record<string, any>): Promise<string> {
    if (!args.domain || !args.endpoint) {
      return JSON.stringify({ error: "Both domain and endpoint are required" });
    }
    return await networkInterceptor.readSchema(args.domain, args.endpoint);
  }

  // ============================================
  // LIFECYCLE
  // ============================================

  /**
   * Gracefully close the browser context.
   */
  async close(): Promise<void> {
    if (this.context) {
      try {
        await this.context.close();
      } catch {
        // Context may already be closed
      }
      this.context = null;
      console.log("[HeadlessBridge] Browser closed");
    }
  }
}

// Singleton instance — shared across all gui tool calls
export const headlessBridge = new HeadlessBrowserBridge();

// Cleanup on process exit — close browser so Chromium doesn't linger
function cleanupBrowser(): void {
  if (headlessBridge.isLaunched) {
    headlessBridge.close().catch(() => {});
  }
}
process.on("exit", cleanupBrowser);
process.on("SIGINT", () => { cleanupBrowser(); process.exit(0); });
process.on("SIGTERM", () => { cleanupBrowser(); process.exit(0); });
