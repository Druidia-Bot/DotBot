/**
 * Journal — Shared Helpers
 */

import { join } from "path";
import { homedir } from "os";

export const JOURNAL_DIR = join(homedir(), ".bot", "memory", "journal");

/**
 * Format an ISO date string (YYYY-MM-DD) as a human-readable date.
 */
export function formatDate(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
