/**
 * Local LLM — Cloud Connectivity Monitoring
 *
 * Lightweight check to determine if cloud LLM providers are reachable.
 * Used by selectModel() to decide when to fall back to local inference.
 */

import { createComponentLogger } from "#logging.js";
import { CONNECTIVITY_CHECK_INTERVAL_MS } from "./config.js";

const log = createComponentLogger("local-llm.connectivity");

// ============================================
// STATE
// ============================================

let cloudReachable = true;
let lastConnectivityCheck = 0;

// ============================================
// CONNECTIVITY CHECK
// ============================================

/**
 * Check if cloud LLM providers are reachable.
 * Uses a lightweight HEAD request to the DeepSeek API.
 * Caches result for CONNECTIVITY_CHECK_INTERVAL_MS.
 */
export async function isCloudReachable(): Promise<boolean> {
  const now = Date.now();

  // Use cached result if recent
  if (now - lastConnectivityCheck < CONNECTIVITY_CHECK_INTERVAL_MS) {
    return cloudReachable;
  }

  lastConnectivityCheck = now;

  try {
    // Quick connectivity check against DeepSeek's API endpoint
    const response = await fetch("https://api.deepseek.com/models", {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    cloudReachable = response.ok || response.status === 401; // 401 = reachable but no key
    return cloudReachable;
  } catch {
    // Network error — probably offline
    cloudReachable = false;
    log.warn("Cloud connectivity check failed — marking as offline");
    return false;
  }
}
