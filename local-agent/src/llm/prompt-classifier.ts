/**
 * Local LLM Prompt Classifier
 * 
 * Uses Qwen 2.5 0.5B to pre-classify user prompts before they reach the server.
 * Runs entirely on-device — no API calls, no latency to the cloud.
 * 
 * Currently classifies:
 * - multiItem: does the message contain multiple unrelated requests?
 */

import { isLocalModelReady, queryLocalLLM } from "./local-llm.js";

export interface PromptHints {
  /** True if the local LLM detected multiple unrelated items in the message */
  multiItem?: boolean;
}

/**
 * Classify a user prompt using the local LLM.
 * Returns hints that the server can use to improve routing.
 * 
 * Fast (~200-500ms) and cheap (runs on-device).
 * Returns empty hints if the local LLM is not ready or errors out.
 */
export async function classifyPromptLocally(prompt: string): Promise<PromptHints> {
  const hints: PromptHints = {};

  // Skip if local LLM not downloaded/ready
  if (!isLocalModelReady()) return hints;

  // Skip short messages — they can't be multi-item
  if (prompt.length < 40) return hints;

  try {
    const response = await queryLocalLLM(
      `Message: "${prompt}"\n\nDoes this message contain multiple UNRELATED requests or tasks? (e.g. "delete X, also update Y, and merge Z")\nReply YES or NO.`,
      "You classify user messages. Reply with ONLY yes or no. Nothing else.",
      8,
    );

    const normalized = response.trim().toLowerCase();
    if (normalized.startsWith("yes")) {
      hints.multiItem = true;
    }
  } catch {
    // Local LLM failed — no hints, server falls back to regex heuristic
  }

  return hints;
}
