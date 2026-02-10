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

const CLASSIFIER_TIMEOUT_MS = 3_000;
const MAX_PROMPT_LENGTH = 500;

/**
 * Classify a user prompt using the local LLM.
 * Returns hints that the server can use to improve routing.
 * 
 * Fast (~200-500ms) and cheap (runs on-device).
 * Returns empty hints if the local LLM is not ready, times out, or errors out.
 */
export async function classifyPromptLocally(prompt: string): Promise<PromptHints> {
  const hints: PromptHints = {};

  // Skip if local LLM not downloaded/ready
  if (!isLocalModelReady()) return hints;

  // Skip short messages — they can't be multi-item
  if (prompt.length < 40) return hints;

  try {
    // Truncate long prompts — the small model doesn't need the full text
    const truncated = prompt.length > MAX_PROMPT_LENGTH
      ? prompt.slice(0, MAX_PROMPT_LENGTH) + "..."
      : prompt;

    // Race with timeout — never block the user's prompt path
    const response = await Promise.race([
      queryLocalLLM(
        `Message: ${truncated}\n\nDoes this message contain multiple UNRELATED requests or tasks? (e.g. "delete X, also update Y, and merge Z")\nReply YES or NO.`,
        "You classify user messages. Reply with ONLY yes or no. Nothing else.",
        8,
      ),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("classifier timeout")), CLASSIFIER_TIMEOUT_MS)
      ),
    ]);

    const normalized = response.trim().toLowerCase();
    if (normalized.startsWith("yes")) {
      hints.multiItem = true;
    }
  } catch {
    // Local LLM failed or timed out — no hints, server falls back to regex heuristic
  }

  return hints;
}
