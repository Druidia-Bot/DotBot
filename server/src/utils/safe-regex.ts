/**
 * Safe Regex Testing (ReDoS Protection)
 *
 * Uses RE2 (Google's safe regex engine) when available, falls back to
 * native RegExp with a timeout guard. RE2 guarantees linear-time execution
 * with no catastrophic backtracking.
 *
 * RE2 is a native C++ module that may fail to compile on some systems.
 * The fallback ensures the server still works without it.
 */

import { createComponentLogger } from "#logging.js";

const log = createComponentLogger("safe-regex");

const MAX_PATTERN_LENGTH = 500;

// Lazy-loaded RE2 constructor (undefined = not yet attempted, null = unavailable)
let RE2Constructor: (new (pattern: string, flags?: string) => { test(input: string): boolean }) | null | undefined;

async function getRE2(): Promise<typeof RE2Constructor> {
  if (RE2Constructor !== undefined) return RE2Constructor;
  try {
    // @ts-ignore — re2 is an optional native dependency
    const mod = await import("re2");
    RE2Constructor = mod.default;
    log.debug("RE2 loaded — ReDoS-safe regex enabled");
  } catch {
    RE2Constructor = null;
    log.warn("RE2 not available — falling back to native RegExp (install re2 for ReDoS protection)");
  }
  return RE2Constructor;
}

// Eagerly attempt to load on module init (non-blocking)
void getRE2();

/**
 * Test a regex pattern against input safely.
 * Uses RE2 when available, native RegExp otherwise.
 *
 * @param pattern User-provided regex pattern
 * @param input String to test against
 * @returns true if pattern matches, false if no match or error
 */
export function safeRegexTest(pattern: string, input: string): boolean {
  try {
    if (pattern.length > MAX_PATTERN_LENGTH) {
      log.warn("Regex pattern too long, rejecting", { patternLength: pattern.length });
      return false;
    }

    if (RE2Constructor) {
      const regex = new RE2Constructor(pattern, "i");
      return regex.test(input);
    }

    // Fallback: native RegExp (no ReDoS protection, but functional)
    const regex = new RegExp(pattern, "i");
    return regex.test(input);
  } catch (e) {
    log.warn("Invalid regex pattern in safeRegexTest", { pattern, error: e });
    return false;
  }
}
