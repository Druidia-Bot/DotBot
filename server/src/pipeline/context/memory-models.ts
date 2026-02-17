/**
 * Context — Model Fetchers
 *
 * Canonical API for fetching memory models. All consumers (Dot,
 * receptionist, etc.) should import from here — no direct WS calls.
 *
 *   fetchAllModels(deviceId)        → full model objects[]
 *   fetchAllModelSpines(deviceId)   → rendered markdown spines[]
 *   fetchModel(deviceId, slug)      → single full model | null
 *   fetchModelSpine(deviceId, slug) → single rendered spine | null
 */

import { createComponentLogger } from "#logging.js";
import { sendMemoryRequest } from "#ws/device-bridge.js";
import { formatModelSpine } from "#tool-loop/handlers/memory-get-model-spine.js";
import type { MemoryRequest } from "#ws/devices.js";

const log = createComponentLogger("context.memory");

/**
 * Fetch all hot mental models from the local agent in one WS round-trip.
 * Returns full model objects. Empty array on failure.
 */
export async function fetchAllModels(deviceId: string): Promise<any[]> {
  try {
    const result = await sendMemoryRequest(deviceId, {
      action: "get_all_models",
    } as MemoryRequest);
    if (Array.isArray(result)) {
      log.info("Fetched all mental models", { count: result.length });
      return result;
    }
  } catch (err) {
    log.warn("Failed to fetch all mental models from local agent", { error: err });
  }
  return [];
}

/**
 * Fetch all hot models and render each as a structured markdown spine.
 * Returns { model, spine }[] so callers can filter/sort on model fields
 * while using the pre-rendered spine for prompt injection.
 */
export async function fetchAllModelSpines(deviceId: string): Promise<{ model: any; spine: string }[]> {
  const models = await fetchAllModels(deviceId);
  return models.map(m => ({ model: m, spine: formatModelSpine(m) }));
}

/**
 * Fetch a single mental model by slug. Returns null if not found.
 */
export async function fetchModel(deviceId: string, slug: string): Promise<any | null> {
  try {
    const result = await sendMemoryRequest(deviceId, {
      action: "get_model_detail",
      modelSlug: slug,
    } as MemoryRequest);
    return result ?? null;
  } catch (err) {
    log.warn("Failed to fetch mental model", { slug, error: err });
    return null;
  }
}

/**
 * Fetch a single mental model by slug and render it as a markdown spine.
 * Optional confidence score is included in the spine header.
 */
export async function fetchModelSpine(
  deviceId: string,
  slug: string,
  confidence?: number,
): Promise<string | null> {
  const model = await fetchModel(deviceId, slug);
  if (!model) return null;
  return formatModelSpine(model, confidence);
}
