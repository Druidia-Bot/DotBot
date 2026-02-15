/**
 * Resilient Image Client — Runtime Provider Fallback for Image Generation
 */

import { createComponentLogger } from "#logging.js";
import { isRetryableError } from "./retry.js";
import { FALLBACK_CHAINS } from "../config.js";
import { getApiKeyForProvider } from "../selection/model-selector.js";
import type {
  IImageClient,
  LLMProvider,
  ImageGenerateRequest,
  ImageEditRequest,
  ImageResult,
} from "../types.js";

const log = createComponentLogger("llm.resilient-image");

export class ResilientImageClient implements IImageClient {
  provider: LLMProvider;
  private primary: IImageClient;
  private imageClientFactory: (provider: LLMProvider, apiKey: string) => IImageClient | null;

  constructor(
    primary: IImageClient,
    imageClientFactory: (provider: LLMProvider, apiKey: string) => IImageClient | null,
  ) {
    this.primary = primary;
    this.provider = primary.provider;
    this.imageClientFactory = imageClientFactory;
  }

  async generate(request: ImageGenerateRequest): Promise<ImageResult> {
    try {
      return await this.primary.generate(request);
    } catch (error) {
      if (!isRetryableError(error)) throw error;
      log.warn("Primary image provider failed, trying fallbacks", {
        provider: this.primary.provider,
        error: error instanceof Error ? error.message.substring(0, 200) : String(error),
      });
      return this.withFallbacks((client) => client.generate(request), error);
    }
  }

  async edit(request: ImageEditRequest): Promise<ImageResult> {
    try {
      return await this.primary.edit(request);
    } catch (error) {
      if (!isRetryableError(error)) throw error;
      log.warn("Primary image provider edit failed, trying fallbacks", {
        provider: this.primary.provider,
        error: error instanceof Error ? error.message.substring(0, 200) : String(error),
      });
      return this.withFallbacks((client) => client.edit(request), error);
    }
  }

  private async withFallbacks(
    fn: (client: IImageClient) => Promise<ImageResult>,
    originalError: unknown,
  ): Promise<ImageResult> {
    const chain = FALLBACK_CHAINS.image || [];
    for (const entry of chain) {
      if (entry.provider === this.primary.provider) continue;
      const key = getApiKeyForProvider(entry.provider);
      if (!key) continue;
      const client = this.imageClientFactory(entry.provider, key);
      if (!client) continue;
      try {
        log.info("Attempting image fallback", { from: this.primary.provider, to: entry.provider });
        const result = await fn(client);
        log.info("Image fallback succeeded", { provider: entry.provider });
        return result;
      } catch (fbError) {
        log.warn("Image fallback also failed", {
          provider: entry.provider,
          error: fbError instanceof Error ? fbError.message.substring(0, 200) : String(fbError),
        });
      }
    }
    throw originalError;
  }
}
