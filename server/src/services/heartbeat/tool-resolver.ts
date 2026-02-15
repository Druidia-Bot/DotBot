/**
 * Heartbeat — Tool Resolver
 *
 * Fetches the tool manifest from the local agent and filters it
 * to only the categories allowed by the heartbeat persona.
 */

import { createComponentLogger } from "#logging.js";
import { requestTools } from "#ws/device-bridge.js";

const log = createComponentLogger("heartbeat.tools");

const DEFAULT_ALLOWED_CATEGORIES = [
  "search",
  "http",
  "shell",
  "filesystem",
];

/**
 * Fetch tools from the local agent and filter to persona-allowed categories.
 * Returns an empty array on failure (graceful degradation).
 */
export async function resolveHeartbeatTools(
  deviceId: string,
  personaTools?: string[],
): Promise<any[]> {
  try {
    const toolResult = await requestTools(deviceId);
    if (!toolResult?.tools?.length) return [];

    const allowedCategories = personaTools || DEFAULT_ALLOWED_CATEGORIES;
    return toolResult.tools.filter(
      (t: any) =>
        allowedCategories.includes("all") ||
        allowedCategories.includes(t.category),
    );
  } catch {
    log.debug("Could not fetch tools for heartbeat, falling back to LLM-only");
    return [];
  }
}
