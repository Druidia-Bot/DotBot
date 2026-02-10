/**
 * Compound Browser Actions
 * 
 * Multi-step browser operations that reduce cloud round-trips by combining
 * several Playwright actions into a single tool call:
 * - searchWebsite: navigate + find search box + type query + submit
 * - fillAndSubmit: fill multiple form fields + click submit
 */

import type { Page } from "playwright";
import { sanitizeUrl, detectBotChallenge, openInSystemBrowser, buildBotChallengeResult } from "./browser-utils.js";

// ============================================
// SEARCH WEBSITE
// ============================================

/**
 * gui.search_website — Navigate to a site, find the search box, type a query, and submit.
 * All in one call. Returns ARIA snapshot of the results page.
 */
export async function searchWebsite(page: Page, args: Record<string, any>): Promise<string> {
  const rawUrl = args.url as string;
  const query = args.query as string;
  const searchButtonText = args.search_button_text as string | undefined;

  if (!rawUrl) return JSON.stringify({ error: "No url provided" });
  if (!query) return JSON.stringify({ error: "No query provided" });

  const { url: fullUrl, error: urlError } = sanitizeUrl(rawUrl);
  if (urlError) return JSON.stringify({ error: urlError });

  try {
    // Step 1: Navigate
    await page.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // Check for bot challenge
    const challenge = await detectBotChallenge(page);
    if (challenge) {
      const { opened, browserName } = await openInSystemBrowser(fullUrl);
      // Carry the original search intent so the agent can complete it in the desktop browser
      const pendingAction = `Once the page loads, find the search box and type '${query}', then press Enter or click Search`;
      return JSON.stringify(buildBotChallengeResult(fullUrl, challenge, opened, browserName, pendingAction));
    }

    // Step 2: Find search input — try common patterns
    const searchSelectors = [
      'input[type="search"]',
      'input[name="q"]',
      'input[name="query"]',
      'input[name="search"]',
      'input[placeholder*="earch" i]',
      'input[aria-label*="earch" i]',
      'input[type="text"]:first-of-type',
      '[role="searchbox"]',
      '[role="combobox"]',
    ];

    let searchInput = null;
    for (const selector of searchSelectors) {
      try {
        const el = page.locator(selector).first();
        if (await el.isVisible({ timeout: 1000 })) {
          searchInput = el;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!searchInput) {
      // Return state so the agent can figure out what to do
      const snapshot = await page.locator("body").ariaSnapshot();
      return JSON.stringify({
        searched: false,
        url: page.url(),
        title: await page.title(),
        error: "Could not find search input",
        aria_snapshot: snapshot.substring(0, 3000),
      });
    }

    // Step 3: Type query
    await searchInput.click();
    await searchInput.fill(query);

    // Step 4: Submit — either click button or press Enter
    if (searchButtonText) {
      try {
        await page.getByRole("button", { name: searchButtonText }).click({ timeout: 3000 });
      } catch {
        // Fallback: try any clickable with that text
        try {
          await page.locator(`text="${searchButtonText}"`).first().click({ timeout: 2000 });
        } catch {
          await searchInput.press("Enter");
        }
      }
    } else {
      await searchInput.press("Enter");
    }

    // Step 5: Wait for navigation / results
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});

    // Return ARIA snapshot of results
    const snapshot = await page.locator("body").ariaSnapshot();
    return JSON.stringify({
      searched: true,
      url: page.url(),
      title: await page.title(),
      query,
      aria_snapshot: snapshot.substring(0, 5000),
    });
  } catch (err) {
    return JSON.stringify({
      searched: false,
      url: fullUrl,
      query,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ============================================
// FILL AND SUBMIT
// ============================================

/**
 * gui.fill_and_submit — Fill multiple form fields and click submit.
 * All in one call. Returns ARIA snapshot after submission.
 */
export async function fillAndSubmit(page: Page, args: Record<string, any>): Promise<string> {
  const fields = args.fields as Array<{ label: string; value: string }>;
  const submitText = args.submit_text as string;

  if (!Array.isArray(fields) || fields.length === 0) {
    return JSON.stringify({ error: "No fields provided" });
  }
  if (!submitText) {
    return JSON.stringify({ error: "No submit_text provided" });
  }

  const fieldResults: Array<{ label: string; filled: boolean; error?: string }> = [];

  try {
    // Fill each field
    for (const field of fields) {
      try {
        // Try by label association first
        let input = page.getByLabel(field.label);
        if (await input.count() === 0) {
          // Try by placeholder
          input = page.getByPlaceholder(field.label);
        }
        if (await input.count() === 0) {
          // Try by role with name
          input = page.getByRole("textbox", { name: field.label });
        }

        await input.first().click({ timeout: 3000 });
        await input.first().fill(field.value);
        fieldResults.push({ label: field.label, filled: true });
      } catch (err) {
        fieldResults.push({
          label: field.label,
          filled: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Click submit
    let submitted = false;
    try {
      await page.getByRole("button", { name: submitText }).click({ timeout: 3000 });
      submitted = true;
    } catch {
      try {
        await page.locator(`text="${submitText}"`).first().click({ timeout: 2000 });
        submitted = true;
      } catch {
        // Last resort: try submit button by type
        try {
          await page.locator('button[type="submit"], input[type="submit"]').first().click({ timeout: 2000 });
          submitted = true;
        } catch { /* give up */ }
      }
    }

    // Wait for response
    if (submitted) {
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    }

    const snapshot = await page.locator("body").ariaSnapshot();
    return JSON.stringify({
      submitted,
      url: page.url(),
      title: await page.title(),
      fields_filled: fieldResults,
      aria_snapshot: snapshot.substring(0, 5000),
    });
  } catch (err) {
    return JSON.stringify({
      submitted: false,
      fields_filled: fieldResults,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
