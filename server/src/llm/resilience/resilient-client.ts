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

import { createComponentLogger } from "#logging.js";
import { recordTokenUsage } from "../token-tracker.js";
import { isRetryableError, extractRetryAfterMs, getRuntimeFallbacks } from "./retry.js";
import type {
  ILLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamChunk,
  LLMProvider,
  ModelRole,
} from "../types.js";

const log = createComponentLogger("llm.resilient");

export class ResilientLLMClient implements ILLMClient {
  provider: LLMProvider;
  private primary: ILLMClient;
  private role: ModelRole;
  private clientFactory: (provider: LLMProvider, apiKey: string) => ILLMClient;
  private keyLookup: (provider: LLMProvider) => string;
  private deviceId?: string;

  constructor(
    primary: ILLMClient,
    role: ModelRole,
    clientFactory: (provider: LLMProvider, apiKey: string) => ILLMClient,
    keyLookup: (provider: LLMProvider) => string,
    deviceId?: string,
  ) {
    this.primary = primary;
    this.provider = primary.provider;
    this.role = role;
    this.clientFactory = clientFactory;
    this.keyLookup = keyLookup;
    this.deviceId = deviceId;
  }

  async chat(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse> {
    // Try primary provider first
    try {
      const response = await this.primary.chat(messages, options);
      this.trackUsage(response);
      return response;
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

      const response = await this.chatWithFallbacks(messages, options, error);
      this.trackUsage(response);
      return response;
    }
  }

  private trackUsage(response: LLMResponse): void {
    if (response.usage && this.deviceId) {
      recordTokenUsage({
        deviceId: this.deviceId,
        model: response.model,
        role: this.role,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      });
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
