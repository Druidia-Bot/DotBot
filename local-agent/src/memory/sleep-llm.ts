/**
 * Sleep Cycle — Shared LLM Scoring Utilities
 *
 * Provides a single pattern for scoring similarity via LLM:
 * local Qwen first → server/workhorse fallback → parse numeric response.
 * Used by both loop dedup and model dedup.
 */

import { serverLLMCall } from "../server-llm.js";

export type ServerSender = (message: any) => Promise<any>;

const DEFAULT_LLM_TIMEOUT_MS = 10_000;

// ============================================
// LLM SCORING
// ============================================

/**
 * Ask an LLM to return a numeric similarity score (0.0 - 1.0).
 * Tries local LLM first, falls back to server/workhorse.
 * Throws if neither is available.
 */
export async function queryLLMForScore(
  prompt: string,
  systemPrompt: string,
  sendToServer: ServerSender | null,
  timeoutMs = DEFAULT_LLM_TIMEOUT_MS,
): Promise<number> {
  const raw = await queryLLMRaw(prompt, systemPrompt, sendToServer, timeoutMs);
  return parseLLMScore(raw);
}

/**
 * Get a raw string response from the local LLM (fallback to server).
 * Throws if neither is available.
 */
async function queryLLMRaw(
  prompt: string,
  systemPrompt: string,
  sendToServer: ServerSender | null,
  timeoutMs: number,
): Promise<string> {
  let response: string | undefined;

  // Try local LLM first (lazy-loads the model if downloaded but not yet in memory)
  try {
    const { isLocalModelReady, queryLocalLLM } = await import("../llm/local-llm.js");
    if (isLocalModelReady()) {
      const llmCall = queryLocalLLM(prompt, systemPrompt, 16);
      llmCall.catch(() => {}); // Prevent unhandled rejection if timeout wins
      response = await Promise.race([
        llmCall,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("Local LLM timed out")), timeoutMs)
        ),
      ]);
    }
  } catch {
    // Local LLM unavailable
  }

  // Fallback to server workhorse (cheapest cloud model)
  if (!response) {
    try {
      const serverCall = serverLLMCall({
        provider: "deepseek",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        maxTokens: 16,
        temperature: 0,
      });
      const result = await Promise.race([
        serverCall,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Server LLM timed out")), timeoutMs)
        ),
      ]);
      if (result.success && result.content) {
        response = result.content;
      }
    } catch {
      // Server unavailable too
    }
  }

  if (!response) throw new Error("No LLM available for scoring");
  return response;
}

/**
 * Parse an LLM response into a numeric score (0.0 - 1.0).
 * Returns 0.5 (ambiguous) if the response is unparseable.
 */
function parseLLMScore(response: string): number {
  const match = response.match(/([01]\.?\d*)/);
  if (match) {
    const score = parseFloat(match[1]);
    if (!isNaN(score) && score >= 0 && score <= 1) return score;
  }
  console.warn(`[SleepCycle] LLM returned unparseable score: "${response.trim()}"`);
  return 0.5;
}

// ============================================
// SEMANTIC SIMILARITY
// ============================================

const AUTO_MATCH_WORD_OVERLAP = 0.8;

/**
 * Score semantic similarity between two text descriptions (0.0 - 1.0).
 *
 * Strategy:
 * - Exact match → 1.0
 * - Word overlap >= 80% → return overlap (cheap, obvious match)
 * - Word overlap < 80% → LLM scores it (catches paraphrases like
 *   "go to the store and buy more bananas" vs "we need more bananas")
 * - LLM unavailable → fall back to word overlap as-is
 *
 * @param itemLabel  What kind of items (e.g., "open loop", "belief")
 * @param question   LLM question (e.g., "same unresolved issue?")
 */
export async function scoreSemantic(
  a: string,
  b: string,
  itemLabel: string,
  question: string,
  sendToServer: ServerSender | null,
  timeoutMs = DEFAULT_LLM_TIMEOUT_MS,
): Promise<number> {
  if (a === b) return 1.0;

  const wordOverlap = computeWordOverlap(a, b);

  // Obvious match — no LLM needed
  if (wordOverlap >= AUTO_MATCH_WORD_OVERLAP) return wordOverlap;

  // Everything below 80% goes to LLM for semantic check
  try {
    const prompt = `Item A: "${a}"\n\nItem B: "${b}"\n\n${question}\nReply with ONLY a number from 0.0 to 1.0:\n- 1.0 = definitely the same ${itemLabel}\n- 0.5 = possibly the same, not sure\n- 0.0 = definitely different`;
    const systemPrompt = `You compare two ${itemLabel} descriptions and return a single similarity score. Reply with ONLY a decimal number between 0.0 and 1.0. No explanation.`;
    return await queryLLMForScore(prompt, systemPrompt, sendToServer, timeoutMs);
  } catch {
    // LLM unavailable — fall back to heuristic
    return wordOverlap;
  }
}

// ============================================
// TEXT SIMILARITY
// ============================================

/**
 * Normalized word overlap between two strings (0.0 - 1.0).
 * Filters words to length > 2 and lowercases everything.
 */
export function computeWordOverlap(a: string, b: string): number {
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 2);
  const wordsA = normalize(a);
  const wordsB = normalize(b);
  if (wordsA.length === 0 || wordsB.length === 0) return 0;

  const setA = new Set(wordsA);
  const overlap = wordsB.filter(w => setA.has(w)).length;
  return overlap / Math.max(wordsA.length, wordsB.length);
}

/**
 * Check if the local LLM is loaded and ready for scoring.
 */
export async function isLocalLLMReady(): Promise<boolean> {
  try {
    const { isLocalModelReady } = await import("../llm/local-llm.js");
    return isLocalModelReady();
  } catch {
    return false;
  }
}
