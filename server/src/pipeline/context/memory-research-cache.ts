/**
 * Context — Research Cache Fetcher
 *
 * Fetches the research cache index from the local agent.
 */

import { createComponentLogger } from "#logging.js";
import { sendMemoryRequest } from "#ws/device-bridge.js";
import type { MemoryRequest } from "#ws/devices.js";
import type { ResearchCacheEntry } from "./memory-types.js";

const log = createComponentLogger("context.memory");

/**
 * Fetch the research cache index from the local agent.
 * Returns the list of cached research entries (lightweight metadata only).
 */
export async function fetchResearchCacheIndex(deviceId: string): Promise<ResearchCacheEntry[]> {
  try {
    const result = await sendMemoryRequest(deviceId, {
      action: "get_research_cache_index",
    } as MemoryRequest);
    if (result?.entries && Array.isArray(result.entries)) {
      log.info("Research cache index fetched", { count: result.entries.length });
      return result.entries;
    }
  } catch (err) {
    log.warn("Failed to fetch research cache index from local agent", { error: err });
  }
  return [];
}
