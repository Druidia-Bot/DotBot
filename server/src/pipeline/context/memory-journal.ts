/**
 * Context — Journal Fetcher
 *
 * Fetches available Assistant's Log journal filenames from the local agent.
 */

import { createComponentLogger } from "#logging.js";
import { sendMemoryRequest } from "#ws/device-bridge.js";
import type { MemoryRequest } from "#ws/devices.js";

const log = createComponentLogger("context.memory");

/**
 * Fetch available Assistant's Log journal filenames from the local agent.
 * Returns date-based filenames (e.g. "2026-02-16.md") most recent first.
 */
export async function fetchJournalFiles(deviceId: string): Promise<string[]> {
  try {
    const result = await sendMemoryRequest(deviceId, {
      action: "get_journal_files",
    } as MemoryRequest);
    if (Array.isArray(result)) {
      log.info("Journal files fetched", { count: result.length });
      return result;
    }
  } catch (err) {
    log.warn("Failed to fetch journal files from local agent", { error: err });
  }
  return [];
}
