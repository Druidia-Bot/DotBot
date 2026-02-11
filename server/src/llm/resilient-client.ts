/**
 * Resilient LLM Client — Runtime Provider Fallback
 * 
 * Wraps an ILLMClient and catches retryable errors (429, 500, 502, 503, 504,
 * network failures). On failure, automatically creates a new client from the
 * fallback chain and retries the same call.
 * 
 * This is the runtime complement to model-selector.ts, which handles
 * selection-time fallback (missing API keys). Together they provide:
 * 
 * 1. Selection-time: "Gemini key missing → use Anthropic instead"
 * 2. Runtime: "Gemini returned 429 → retry with Anthropic"
 * 
 * All call sites that use createClientForSelection() get this automatically.
 */

import { createComponentLogger } from "../logging.js";
import type {
  ILLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamChunk,
  LLMProvider,
  ModelRole,
} from "./types.js";

const log = createComponentLogger("llm.resilient");

// ============================================
// RETRYABLE ERROR DETECTION
// ============================================

/** HTTP status codes that indicate a transient/retryable failure */
const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];

/** Error message patterns that indicate a transient/retryable failure */
const RETRYABLE_PATTERNS = [
  "rate limit",
  "too many requests",
  "fetch failed",
  "econnrefused",
  "econnreset",
  "enotfound",
  "network",
  "timeout",
  "timed out",
  "socket hang up",
  "aborted",
];

/**
 * Check if an error is retryable (transient failure that another provider
 * might not have).
 */
export function isRetryableError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();

  // Check for retryable HTTP status codes in the error message
  for (const code of RETRYABLE_STATUS_CODES) {
    if (msg.includes(String(code))) return true;
  }

  // Check for retryable patterns
  for (const pattern of RETRYABLE_PATTERNS) {
    if (msg.includes(pattern)) return true;
  }

  return false;
}

/**
 * Extract Retry-After delay from an error message (if the provider included it).
 * Returns delay in ms, or 0 if not found.
 */
function extractRetryAfterMs(error: unknown): number {
  const msg = error instanceof Error ? error.message : String(error);
  // Look for "retry-after: N" or "retry after N seconds" patterns
  const match = msg.match(/retry[- ]after:?\s*(\d+)/i);
  if (match) {
    const seconds = parseInt(match[1], 10);
    // Cap at 30 seconds — if a provider says "wait 60s", try fallback instead
    return seconds <= 30 ? seconds * 1000 : 0;
  }
  return 0;
}

// ============================================
// FALLBACK PROVIDER RESOLVER
// ============================================

export interface FallbackEntry {
  provider: LLMProvider;
  model: string;
  temperature: number;
  maxTokens: number;
}

/**
 * Get the runtime fallback chain for a role, excluding the primary provider
 * (which already failed). This re-uses the same chains as model-selector.ts
 * but is called at runtime instead of selection time.
 */
export function getRuntimeFallbacks(role: ModelRole, failedProvider: LLMProvider): FallbackEntry[] {
  const chains: Record<ModelRole, FallbackEntry[]> = {
    workhorse: [
      { provider: "deepseek", model: "deepseek-chat", temperature: 0.0, maxTokens: 4096 },
      { provider: "gemini", model: "gemini-2.5-flash", temperature: 0.0, maxTokens: 4096 },
      { provider: "openai", model: "gpt-4o-mini", temperature: 0.0, maxTokens: 4096 },
      { provider: "anthropic", model: "claude-3-5-haiku-20241022", temperature: 0.0, maxTokens: 4096 },
      { provider: "local", model: "qwen2.5-0.5b-instruct-q4_k_m", temperature: 0.3, maxTokens: 1024 },
    ],
    deep_context: [
      { provider: "gemini", model: "gemini-3-pro-preview", temperature: 0.3, maxTokens: 8192 },
      { provider: "anthropic", model: "claude-opus-4-6", temperature: 0.3, maxTokens: 8192 },
      { provider: "deepseek", model: "deepseek-chat", temperature: 0.0, maxTokens: 4096 },
    ],
    architect: [
      { provider: "anthropic", model: "claude-opus-4-6", temperature: 0.0, maxTokens: 8192 },
      { provider: "deepseek", model: "deepseek-reasoner", temperature: 0.0, maxTokens: 8192 },
      { provider: "gemini", model: "gemini-3-pro-preview", temperature: 0.0, maxTokens: 8192 },
    ],
    local: [
      { provider: "local", model: "qwen2.5-0.5b-instruct-q4_k_m", temperature: 0.3, maxTokens: 1024 },
      { provider: "deepseek", model: "deepseek-chat", temperature: 0.3, maxTokens: 1024 },
    ],
    gui_fast: [
      { provider: "gemini", model: "gemini-2.5-flash", temperature: 0.0, maxTokens: 4096 },
      { provider: "openai", model: "gpt-4o-mini", temperature: 0.0, maxTokens: 4096 },
      { provider: "deepseek", model: "deepseek-chat", temperature: 0.0, maxTokens: 4096 },
      { provider: "local", model: "qwen2.5-0.5b-instruct-q4_k_m", temperature: 0.3, maxTokens: 1024 },
    ],
    intake: [
      { provider: "xai", model: "grok-4-1-fast-non-reasoning", temperature: 0.0, maxTokens: 4096 },
      { provider: "gemini", model: "gemini-2.5-flash", temperature: 0.0, maxTokens: 4096 },
      { provider: "deepseek", model: "deepseek-chat", temperature: 0.0, maxTokens: 4096 },
      { provider: "openai", model: "gpt-4o-mini", temperature: 0.0, maxTokens: 4096 },
      { provider: "local", model: "qwen2.5-0.5b-instruct-q4_k_m", temperature: 0.3, maxTokens: 1024 },
    ],
  };

  const chain = chains[role] || [];
  // Exclude the provider that already failed
  return chain.filter(entry => entry.provider !== failedProvider);
}

// ============================================
// RESILIENT CLIENT WRAPPER
// ============================================

export class ResilientLLMClient implements ILLMClient {
  provider: LLMProvider;
  private primary: ILLMClient;
  private role: ModelRole;
  private clientFactory: (provider: LLMProvider, apiKey: string) => ILLMClient;
  private keyLookup: (provider: LLMProvider) => string;

  constructor(
    primary: ILLMClient,
    role: ModelRole,
    clientFactory: (provider: LLMProvider, apiKey: string) => ILLMClient,
    keyLookup: (provider: LLMProvider) => string
  ) {
    this.primary = primary;
    this.provider = primary.provider;
    this.role = role;
    this.clientFactory = clientFactory;
    this.keyLookup = keyLookup;
  }

  async chat(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse> {
    // Try primary provider first
    try {
      return await this.primary.chat(messages, options);
    } catch (error) {
      if (!isRetryableError(error)) throw error;

      log.warn("Primary provider failed with retryable error, trying fallbacks", {
        provider: this.primary.provider,
        role: this.role,
        error: error instanceof Error ? error.message.substring(0, 200) : String(error),
      });

      // Optional short delay if Retry-After was specified and small
      const retryDelay = extractRetryAfterMs(error);
      if (retryDelay > 0) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }

      return this.chatWithFallbacks(messages, options, error);
    }
  }

  async *stream(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): AsyncGenerator<LLMStreamChunk, void, unknown> {
    // Try primary provider first
    try {
      yield* this.primary.stream(messages, options);
      return;
    } catch (error) {
      if (!isRetryableError(error)) throw error;

      log.warn("Primary provider stream failed with retryable error, trying fallbacks", {
        provider: this.primary.provider,
        role: this.role,
        error: error instanceof Error ? error.message.substring(0, 200) : String(error),
      });

      yield* this.streamWithFallbacks(messages, options, error);
    }
  }

  // ============================================
  // FALLBACK EXECUTION
  // ============================================

  private async chatWithFallbacks(
    messages: LLMMessage[],
    options: LLMRequestOptions | undefined,
    originalError: unknown
  ): Promise<LLMResponse> {
    const fallbacks = getRuntimeFallbacks(this.role, this.primary.provider);

    for (const fallback of fallbacks) {
      const apiKey = this.keyLookup(fallback.provider);
      if (!apiKey && fallback.provider !== "local") continue;

      try {
        const client = this.clientFactory(fallback.provider, apiKey);
        log.info("Attempting runtime fallback", {
          from: this.primary.provider,
          to: fallback.provider,
          model: fallback.model,
          role: this.role,
        });

        // Use fallback's model but preserve the caller's other options
        const fallbackOptions: LLMRequestOptions = {
          ...options,
          model: fallback.model,
          // Don't override temperature/maxTokens if caller specified them
          temperature: options?.temperature ?? fallback.temperature,
          maxTokens: options?.maxTokens ?? fallback.maxTokens,
        };

        const result = await client.chat(messages, fallbackOptions);

        log.info("Runtime fallback succeeded", {
          provider: fallback.provider,
          model: fallback.model,
          role: this.role,
        });

        return result;
      } catch (fallbackError) {
        log.warn("Fallback provider also failed", {
          provider: fallback.provider,
          error: fallbackError instanceof Error ? fallbackError.message.substring(0, 200) : String(fallbackError),
        });
        // Continue to next fallback
      }
    }

    // All fallbacks exhausted — throw the original error
    throw originalError;
  }

  private async *streamWithFallbacks(
    messages: LLMMessage[],
    options: LLMRequestOptions | undefined,
    originalError: unknown
  ): AsyncGenerator<LLMStreamChunk, void, unknown> {
    const fallbacks = getRuntimeFallbacks(this.role, this.primary.provider);

    for (const fallback of fallbacks) {
      const apiKey = this.keyLookup(fallback.provider);
      if (!apiKey && fallback.provider !== "local") continue;

      try {
        const client = this.clientFactory(fallback.provider, apiKey);
        log.info("Attempting runtime fallback (stream)", {
          from: this.primary.provider,
          to: fallback.provider,
          model: fallback.model,
          role: this.role,
        });

        const fallbackOptions: LLMRequestOptions = {
          ...options,
          model: fallback.model,
          temperature: options?.temperature ?? fallback.temperature,
          maxTokens: options?.maxTokens ?? fallback.maxTokens,
        };

        yield* client.stream(messages, fallbackOptions);

        log.info("Runtime fallback stream succeeded", {
          provider: fallback.provider,
          model: fallback.model,
        });

        return;
      } catch (fallbackError) {
        log.warn("Fallback provider stream also failed", {
          provider: fallback.provider,
          error: fallbackError instanceof Error ? fallbackError.message.substring(0, 200) : String(fallbackError),
        });
        // Continue to next fallback
      }
    }

    // All fallbacks exhausted — throw the original error
    throw originalError;
  }
}
