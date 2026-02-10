/**
 * Network-Level Ad & Tracker Blocking
 * 
 * Layer 1 of the two-layer ad blocking system for the headless browser.
 * Intercepts requests via Playwright's context.route() and blocks known
 * ad/tracker domains before they leave the browser. Zero overhead —
 * requests never fire, resources never download.
 * 
 * Layer 2 (uBlock Origin extension) handles cosmetic filtering and is
 * loaded via Chromium launch args in headless-bridge.ts.
 * 
 * Blocklist stored at ~/.bot/browser-data/blocklist.txt (one domain per line).
 * Falls back to a curated built-in list if the file doesn't exist.
 */

import { promises as fs } from "fs";
import { join } from "path";
import type { BrowserContext } from "playwright";

// ============================================
// BUILT-IN BLOCKLIST (curated top ad/tracker domains)
// ============================================

const BUILTIN_DOMAINS: string[] = [
  // Google Ads
  "pagead2.googlesyndication.com",
  "googleads.g.doubleclick.net",
  "ad.doubleclick.net",
  "adservice.google.com",
  "www.googletagservices.com",
  "tpc.googlesyndication.com",
  // Facebook tracking
  "pixel.facebook.com",
  "connect.facebook.net",
  "an.facebook.com",
  "pixel.facebook.net",
  // Analytics & tracking
  "www.google-analytics.com",
  "ssl.google-analytics.com",
  "analytics.google.com",
  "stats.g.doubleclick.net",
  "bat.bing.com",
  "tags.bluekai.com",
  "s.amazon-adsystem.com",
  "z-na.amazon-adsystem.com",
  // Ad networks
  "ads.yahoo.com",
  "advertising.com",
  "ib.adnxs.com",
  "secure.adnxs.com",
  "ad.turn.com",
  "ad.crwdcntrl.net",
  "cdn.krxd.net",
  "cdn.taboola.com",
  "trc.taboola.com",
  "cdn.outbrain.com",
  "widgets.outbrain.com",
  "dis.criteo.com",
  "bidder.criteo.com",
  "static.criteo.net",
  "adsrvr.org",
  "match.adsrvr.org",
  "insight.adsrvr.org",
  "ads.pubmatic.com",
  "image2.pubmatic.com",
  "ssp.contextweb.com",
  "sync.1rx.io",
  "c.amazon-adsystem.com",
  "aax.amazon-adsystem.com",
  // Trackers
  "tr.snapchat.com",
  "sc-static.net",
  "t.co",
  "analytics.twitter.com",
  "static.ads-twitter.com",
  "ads-api.twitter.com",
  "pixel.quantserve.com",
  "edge.quantserve.com",
  "secure.quantserve.com",
  "sb.scorecardresearch.com",
  "b.scorecardresearch.com",
  "cdn.segment.io",
  "api.segment.io",
  "cdn.mxpnl.com",
  "api-js.mixpanel.com",
  "cdn.heapanalytics.com",
  "heapanalytics.com",
  "app.pendo.io",
  "cdn.pendo.io",
  "sentry.io",
  // Pop-ups & overlays
  "cdn.onesignal.com",
  "onesignal.com",
  "notix.io",
  "pushnews.eu",
  "pushwoosh.com",
];

// ============================================
// BLOCKLIST LOADING
// ============================================

let blockedDomains: Set<string> | null = null;

/**
 * Load the domain blocklist. Tries ~/.bot/browser-data/blocklist.txt first,
 * falls back to built-in list.
 */
async function loadBlocklist(browserDataDir: string): Promise<Set<string>> {
  if (blockedDomains) return blockedDomains;

  const domains = new Set<string>(BUILTIN_DOMAINS);
  const blocklistPath = join(browserDataDir, "blocklist.txt");

  try {
    const content = await fs.readFile(blocklistPath, "utf-8");
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        domains.add(trimmed.toLowerCase());
      }
    }
    console.log(`[AdBlock] Loaded ${domains.size} blocked domains (${domains.size - BUILTIN_DOMAINS.length} from blocklist.txt)`);
  } catch {
    console.log(`[AdBlock] Using built-in blocklist (${domains.size} domains)`);
  }

  blockedDomains = domains;
  return domains;
}

// ============================================
// ROUTE INTERCEPTOR
// ============================================

/**
 * Apply network-level ad/tracker blocking to a browser context.
 * Intercepts all requests and aborts those matching blocked domains.
 */
export async function applyNetworkBlocklist(context: BrowserContext, browserDataDir: string): Promise<void> {
  const domains = await loadBlocklist(browserDataDir);

  await context.route("**/*", (route) => {
    try {
      const url = new URL(route.request().url());
      if (domains.has(url.hostname)) {
        return route.abort("blockedbyclient");
      }
    } catch {
      // Malformed URL — let it through
    }
    return route.continue();
  });

  console.log(`[AdBlock] Network-level blocking active (${domains.size} domains)`);
}

/**
 * Clear the cached blocklist (forces reload on next apply).
 */
export function clearBlocklistCache(): void {
  blockedDomains = null;
}
