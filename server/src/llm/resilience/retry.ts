/**
 * Retry & Error Detection — Shared utilities for resilient clients
 *
 * Determines whether an error is transient (retryable) and extracts
 * Retry-After hints from error messages.
 */

import type { LLMProvider, ModelRole } from "../types.js";
import { FALLBACK_CHAINS } from "../config.js";
import type { FallbackEntry } from "../config.js";

// ============================================
// RETRYABLE ERROR DETECTION
// ============================================

/** HTTP status codes that indicate a transient/retryable failure */
const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];

/** Error message patterns that indicate a transient/retryable failure */
const RETRYABLE_PATTERNS = [
  "rate limit",
  "too many requests",
  "fetch failed",
  "econnrefused",
  "econnreset",
  "enotfound",
  "network",
  "timeout",
  "timed out",
  "socket hang up",
  "aborted",
];

/**
 * Check if an error is retryable (transient failure that another provider
 * might not have).
 */
export function isRetryableError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();

  // Check for retryable HTTP status codes in the error message
  for (const code of RETRYABLE_STATUS_CODES) {
    if (msg.includes(String(code))) return true;
  }

  // Check for retryable patterns
  for (const pattern of RETRYABLE_PATTERNS) {
    if (msg.includes(pattern)) return true;
  }

  return false;
}

/**
 * Extract Retry-After delay from an error message (if the provider included it).
 * Returns delay in ms, or 0 if not found.
 */
export function extractRetryAfterMs(error: unknown): number {
  const msg = error instanceof Error ? error.message : String(error);
  // Look for "retry-after: N" or "retry after N seconds" patterns
  const match = msg.match(/retry[- ]after:?\s*(\d+)/i);
  if (match) {
    const seconds = parseInt(match[1], 10);
    // Cap at 30 seconds — if a provider says "wait 60s", try fallback instead
    return seconds <= 30 ? seconds * 1000 : 0;
  }
  return 0;
}

// ============================================
// FALLBACK PROVIDER RESOLVER
// ============================================

/**
 * Get the runtime fallback chain for a role, excluding the provider that
 * already failed. Uses the shared FALLBACK_CHAINS from config.ts.
 */
export function getRuntimeFallbacks(role: ModelRole, failedProvider: LLMProvider): FallbackEntry[] {
  const chain = FALLBACK_CHAINS[role] || [];
  return chain.filter(entry => entry.provider !== failedProvider);
}
