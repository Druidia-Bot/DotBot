/**
 * Set-of-Marks (SoM) — Visual Grounding for Headless Browser
 * 
 * Labels every interactive element on a page with a numbered overlay badge.
 * Returns a text manifest mapping IDs to element metadata, plus optionally
 * a screenshot with the labels visible.
 * 
 * Flow:
 *   1. INJECT: page.evaluate() finds all interactive elements
 *   2. LABEL: Draw numbered badge on each visible element, set data-ai-id
 *   3. CATALOG: Return manifest [{id, tag, text, type, role, rect}]
 *   4. SNAPSHOT: Optional screenshot with labels visible
 *   5. CLEANUP: Remove all badges from the DOM
 * 
 * The manifest is the primary output — it tells the LLM what's clickable.
 * Screenshots are only taken when the LLM requests visual mode.
 */

import type { Page } from "playwright";

// ============================================
// TYPES
// ============================================

export interface SoMElement {
  id: number;
  tag: string;
  text: string;
  type: string;
  role: string;
  rect: { x: number; y: number; w: number; h: number };
  href?: string;
  placeholder?: string;
  ariaLabel?: string;
}

export interface SoMResult {
  elements: SoMElement[];
  element_count: number;
  page_url: string;
  page_title: string;
  viewport: { width: number; height: number };
}

// ============================================
// INJECTION SCRIPT (runs inside the browser)
// ============================================

/**
 * JavaScript function serialized and injected into the page via page.evaluate().
 * Finds all interactive elements, draws numbered overlay badges, and returns
 * a manifest of labeled elements.
 */
const SOM_INJECT_SCRIPT = `() => {
  // Remove any existing SoM labels from a previous run
  document.querySelectorAll('[data-ai-som-label]').forEach(el => el.remove());
  document.querySelectorAll('[data-ai-id]').forEach(el => el.removeAttribute('data-ai-id'));

  const INTERACTIVE_SELECTORS = [
    'button', 'a[href]', 'input', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
    '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="option"]',
    '[role="combobox"]', '[role="searchbox"]', '[role="slider"]',
    '[onclick]', '[tabindex]:not([tabindex="-1"])',
    'summary', 'details > summary',
    'label[for]',
  ].join(', ');

  let id = 0;
  const elements = [];

  document.querySelectorAll(INTERACTIVE_SELECTORS).forEach(el => {
    // Skip hidden/zero-size elements
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return;
    if (rect.right < 0 || rect.left > window.innerWidth) return;

    // Skip invisible elements (display:none, visibility:hidden, opacity:0)
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    if (parseFloat(style.opacity) === 0) return;

    // Skip disabled elements
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;

    // Create the numbered overlay badge
    const badge = document.createElement('div');
    badge.setAttribute('data-ai-som-label', 'true');
    badge.innerText = String(id);
    badge.style.cssText = [
      'position:fixed',
      'left:' + Math.max(0, rect.left) + 'px',
      'top:' + Math.max(0, rect.top - 16) + 'px',
      'background:#e11d48',
      'color:white',
      'font-size:11px',
      'font-weight:bold',
      'font-family:monospace',
      'padding:1px 4px',
      'border-radius:3px',
      'z-index:2147483647',
      'pointer-events:none',
      'line-height:14px',
      'min-width:14px',
      'text-align:center',
      'box-shadow:0 1px 3px rgba(0,0,0,0.4)',
    ].join(';');
    document.body.appendChild(badge);

    // Tag the element with data-ai-id for later interaction
    el.setAttribute('data-ai-id', String(id));

    // Extract element metadata
    const text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().slice(0, 80);
    elements.push({
      id: id,
      tag: el.tagName.toLowerCase(),
      text: text,
      type: el.type || '',
      role: el.getAttribute('role') || '',
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      href: el.href ? el.href.slice(0, 200) : undefined,
      placeholder: el.placeholder || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
    });

    id++;
  });

  return elements;
}`;

/**
 * JavaScript to remove all SoM labels and data-ai-id attributes from the page.
 */
const SOM_CLEANUP_SCRIPT = `() => {
  document.querySelectorAll('[data-ai-som-label]').forEach(el => el.remove());
  document.querySelectorAll('[data-ai-id]').forEach(el => el.removeAttribute('data-ai-id'));
}`;

// ============================================
// PUBLIC API
// ============================================

/**
 * Inject Set-of-Marks labels onto a page and return the element manifest.
 * Labels remain on the page until cleanup() is called (allows screenshot capture).
 */
export async function injectSetOfMarks(page: Page): Promise<SoMResult> {
  const elements = await page.evaluate(SOM_INJECT_SCRIPT) as SoMElement[];
  const viewport = page.viewportSize() || { width: 1280, height: 720 };

  return {
    elements,
    element_count: elements.length,
    page_url: page.url(),
    page_title: await page.title(),
    viewport,
  };
}

/**
 * Remove all Set-of-Marks labels from the page.
 */
export async function cleanupSetOfMarks(page: Page): Promise<void> {
  await page.evaluate(SOM_CLEANUP_SCRIPT);
}

/**
 * Inject SoM, take a screenshot with labels visible, then clean up.
 * Returns both the manifest and the screenshot as base64.
 */
export async function captureSetOfMarks(
  page: Page,
  options?: { quality?: number; format?: "jpeg" | "png" }
): Promise<SoMResult & { screenshot_base64: string; screenshot_format: string; screenshot_size_kb: number }> {
  const result = await injectSetOfMarks(page);

  const format = options?.format || "jpeg";
  const quality = Math.max(1, Math.min(options?.quality || 60, 100));

  const screenshotOpts: any = { type: format, scale: "css" as const };
  if (format === "jpeg") screenshotOpts.quality = quality;

  const buffer = await page.screenshot(screenshotOpts);

  await cleanupSetOfMarks(page);

  return {
    ...result,
    screenshot_base64: buffer.toString("base64"),
    screenshot_format: format,
    screenshot_size_kb: Math.round(buffer.length / 1024),
  };
}
