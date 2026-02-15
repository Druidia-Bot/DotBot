/**
 * Resilient Video Client — Runtime Provider Fallback for Video Generation
 */

import { createComponentLogger } from "#logging.js";
import { isRetryableError } from "./retry.js";
import { FALLBACK_CHAINS } from "../config.js";
import { getApiKeyForProvider } from "../selection/model-selector.js";
import type {
  IVideoClient,
  LLMProvider,
  VideoGenerateRequest,
  VideoResult,
} from "../types.js";

const log = createComponentLogger("llm.resilient-video");

export class ResilientVideoClient implements IVideoClient {
  provider: LLMProvider;
  private primary: IVideoClient;
  private videoClientFactory: (provider: LLMProvider, apiKey: string) => IVideoClient | null;

  constructor(
    primary: IVideoClient,
    videoClientFactory: (provider: LLMProvider, apiKey: string) => IVideoClient | null,
  ) {
    this.primary = primary;
    this.provider = primary.provider;
    this.videoClientFactory = videoClientFactory;
  }

  async generate(request: VideoGenerateRequest): Promise<VideoResult> {
    try {
      return await this.primary.generate(request);
    } catch (error) {
      if (!isRetryableError(error)) throw error;
      log.warn("Primary video provider failed, trying fallbacks", {
        provider: this.primary.provider,
        error: error instanceof Error ? error.message.substring(0, 200) : String(error),
      });
      return this.withFallbacks(request, error);
    }
  }

  private async withFallbacks(
    request: VideoGenerateRequest,
    originalError: unknown,
  ): Promise<VideoResult> {
    const chain = FALLBACK_CHAINS.video || [];
    for (const entry of chain) {
      if (entry.provider === this.primary.provider) continue;
      const key = getApiKeyForProvider(entry.provider);
      if (!key) continue;
      const client = this.videoClientFactory(entry.provider, key);
      if (!client) continue;
      try {
        log.info("Attempting video fallback", { from: this.primary.provider, to: entry.provider });
        const result = await client.generate(request);
        log.info("Video fallback succeeded", { provider: entry.provider });
        return result;
      } catch (fbError) {
        log.warn("Video fallback also failed", {
          provider: entry.provider,
          error: fbError instanceof Error ? fbError.message.substring(0, 200) : String(fbError),
        });
      }
    }
    throw originalError;
  }
}
