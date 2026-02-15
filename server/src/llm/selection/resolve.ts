/**
 * Model Resolution
 *
 * Selects an LLM model based on criteria and returns the appropriate client.
 * Extracted from agents/execution.ts because it's a pure LLM utility
 * used across the entire pipeline (intake, receptionist, planner, step-executor, etc.).
 */

import type { ILLMClient, ModelSelection, ModelSelectionCriteria } from "../types.js";
import { selectModel } from "./model-selector.js";
import { createClientForSelection } from "../factory.js";
import { isCloudReachable } from "../providers/local-llm/index.js";
import { createComponentLogger } from "#logging.js";

const log = createComponentLogger("llm.resolve");

/**
 * Run selectModel() and return the appropriate LLM client.
 * If the selection picks the same provider as the current client, reuse it.
 * If it picks a different provider, create a new client for that provider.
 *
 * Automatically checks cloud connectivity so isOffline is set correctly.
 * The connectivity check is cached (60s TTL) so this is cheap to call.
 */
export async function resolveModelAndClient(
  currentLlm: ILLMClient,
  criteria: ModelSelectionCriteria,
  deviceId?: string,
): Promise<{ selectedModel: ModelSelection; client: ILLMClient }> {
  // Check cloud connectivity if not already set in criteria
  if (criteria.isOffline === undefined) {
    const reachable = await isCloudReachable();
    if (!reachable) {
      criteria.isOffline = true;
    }
  }

  const selectedModel = selectModel(criteria);

  // If the selection matches the current client's provider, reuse it
  if (selectedModel.provider === currentLlm.provider) {
    return { selectedModel, client: currentLlm };
  }

  // Different provider needed — create a new client
  try {
    const client = createClientForSelection(selectedModel, deviceId);
    return { selectedModel, client };
  } catch (error) {
    // If we can't create the new client (e.g. missing API key), fall back to current
    log.warn(`Failed to create client for ${selectedModel.provider}, falling back to ${currentLlm.provider}`, { error });
    return { selectedModel, client: currentLlm };
  }
}
