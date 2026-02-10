/**
 * Visual Grounding — Set-of-Marks Integration
 * 
 * Provides visual element discovery and interaction for the headless browser:
 * - findElement: Inject SoM labels, search manifest for target element
 * - readStateVisual: ARIA snapshot + SoM manifest + optional screenshot
 * - clickSoMElement: Click by SoM ID (data-ai-id attribute)
 * - findInManifest: Search SoM manifest by text/type with exact + partial matching
 */

import type { Page, BrowserContext } from "playwright";
import { sanitizeUrl, detectBotChallenge, openInSystemBrowser, buildBotChallengeResult } from "./browser-utils.js";
import { injectSetOfMarks, captureSetOfMarks, cleanupSetOfMarks, type SoMElement } from "./set-of-marks.js";

// ============================================
// FIND ELEMENT
// ============================================

/**
 * gui.find_element — Find an interactive element using Set-of-Marks.
 * Injects SoM labels, searches the manifest for the target, returns match.
 * If include_screenshot is true, also captures a labeled screenshot.
 */
export async function findElement(page: Page, args: Record<string, any>): Promise<string> {
  const elementText = (args.element_text || "").toLowerCase();
  const elementType = (args.element_type || "").toLowerCase();
  const includeScreenshot = args.include_screenshot === true;

  if (!elementText && !elementType) {
    return JSON.stringify({ found: false, error: "No element_text or element_type provided" });
  }

  if (includeScreenshot) {
    // Capture with screenshot (labels stay visible for the shot, then cleaned up)
    const result = await captureSetOfMarks(page, { quality: 60 });
    const match = findInManifest(result.elements, elementText, elementType);

    return JSON.stringify({
      ...match,
      element_count: result.element_count,
      page_url: result.page_url,
      screenshot_base64: result.screenshot_base64,
      screenshot_format: result.screenshot_format,
      screenshot_size_kb: result.screenshot_size_kb,
    });
  } else {
    // Text-only: inject, search, clean up
    const result = await injectSetOfMarks(page);
    const match = findInManifest(result.elements, elementText, elementType);
    await cleanupSetOfMarks(page);

    return JSON.stringify({
      ...match,
      element_count: result.element_count,
      page_url: result.page_url,
    });
  }
}

// ============================================
// READ STATE VISUAL
// ============================================

/**
 * gui.read_state with visual mode — when mode="visual", injects SoM labels
 * and returns the manifest + optional screenshot alongside the ARIA snapshot.
 */
export async function readStateVisual(
  page: Page,
  context: BrowserContext,
  args: Record<string, any>
): Promise<string> {
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

  // Get ARIA snapshot (text mode)
  const snapshot = await page.locator("body").ariaSnapshot();
  const url = page.url();
  const title = await page.title();

  // Get open tabs
  const tabList: { index: number; url: string }[] = [];
  for (const [i, p] of context.pages().entries()) {
    tabList.push({ index: i, url: p.url() });
  }

  // Visual mode: inject SoM + capture screenshot
  const includeScreenshot = args.include_screenshot !== false;
  let somData: any = {};

  if (includeScreenshot) {
    const som = await captureSetOfMarks(page, { quality: args.quality || 60 });
    somData = {
      som_elements: som.elements,
      som_element_count: som.element_count,
      screenshot_base64: som.screenshot_base64,
      screenshot_format: som.screenshot_format,
      screenshot_size_kb: som.screenshot_size_kb,
    };
  } else {
    const som = await injectSetOfMarks(page);
    await cleanupSetOfMarks(page);
    somData = {
      som_elements: som.elements,
      som_element_count: som.element_count,
    };
  }

  return JSON.stringify({
    url,
    title,
    tab_count: tabList.length,
    tabs: tabList,
    aria_snapshot: snapshot,
    mode: "visual",
    ...somData,
  }, null, 2);
}

// ============================================
// CLICK SOM ELEMENT
// ============================================

/**
 * Click an element by its SoM ID (data-ai-id attribute).
 * Used after find_element or read_state visual mode returns SoM IDs.
 */
export async function clickSoMElement(page: Page, somId: number): Promise<string> {
  try {
    const locator = page.locator(`[data-ai-id="${somId}"]`);
    await locator.waitFor({ state: "visible", timeout: 5_000 });
    await locator.click({ timeout: 5_000 });
    return JSON.stringify({ clicked: true, method: "som_id", som_id: somId });
  } catch {
    return JSON.stringify({ clicked: false, error: `SoM element #${somId} not found or not clickable` });
  }
}

// ============================================
// MANIFEST SEARCH
// ============================================

/** Search the SoM manifest for a matching element */
export function findInManifest(
  elements: SoMElement[],
  text: string,
  type: string
): { found: boolean; matches: SoMElement[]; best_match?: SoMElement; error?: string } {
  if (elements.length === 0) {
    return { found: false, matches: [], error: "No interactive elements found on page" };
  }

  let matches = elements;

  // Filter by type if specified
  if (type) {
    const typeMap: Record<string, string[]> = {
      button: ["button", "[role=button]"],
      link: ["a"],
      input: ["input", "textarea"],
      tab: ["[role=tab]"],
      menu_item: ["[role=menuitem]"],
      select: ["select"],
      checkbox: ["[role=checkbox]", "input"],
      radio: ["[role=radio]", "input"],
    };
    const validTags = typeMap[type] || [type];
    matches = matches.filter(el =>
      validTags.some(t => el.tag === t || el.role === type)
    );
  }

  // Filter by text
  if (text) {
    const exactMatches = matches.filter(el =>
      el.text.toLowerCase() === text ||
      el.ariaLabel?.toLowerCase() === text ||
      el.placeholder?.toLowerCase() === text
    );

    if (exactMatches.length > 0) {
      return { found: true, matches: exactMatches, best_match: exactMatches[0] };
    }

    // Partial match
    const partialMatches = matches.filter(el =>
      el.text.toLowerCase().includes(text) ||
      el.ariaLabel?.toLowerCase().includes(text) ||
      el.placeholder?.toLowerCase().includes(text)
    );

    if (partialMatches.length > 0) {
      return { found: true, matches: partialMatches, best_match: partialMatches[0] };
    }

    return {
      found: false,
      matches: [],
      error: `No element matching "${text}"${type ? ` of type "${type}"` : ""}. ${elements.length} interactive elements on page.`,
    };
  }

  // Type-only filter
  if (matches.length > 0) {
    return { found: true, matches, best_match: matches[0] };
  }
  return { found: false, matches: [], error: `No elements of type "${type}" found` };
}
