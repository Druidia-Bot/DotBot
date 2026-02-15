/**
 * LLM Client Factory
 * 
 * Creates provider-specific LLM, image, and video clients.
 * Each provider implementation lives in ./providers/.
 * 
 * To add a new provider:
 * 1. Add it to LLMProvider in ./types.ts
 * 2. Add its config to PROVIDER_CONFIGS in ./config.ts
 * 3. Create a client class implementing ILLMClient in ./providers/your-provider.ts
 * 4. Add a case to the switch in createLLMClient() below
 */

import { createComponentLogger } from "#logging.js";
import type {
  LLMProvider,
  LLMClientOptions,
  ILLMClient,
  IImageClient,
  IVideoClient,
  ModelSelection,
} from "./types.js";
import { PROVIDER_CONFIGS } from "./config.js";
import { DeepSeekClient } from "./providers/deepseek.js";
import { AnthropicClient } from "./providers/anthropic.js";
import { OpenAICompatibleClient, OpenAIImageClient } from "./providers/openai-compatible/index.js";
import { GeminiClient, GeminiImageClient, GeminiVideoClient } from "./providers/gemini/index.js";
import { LocalLLMClient } from "./providers/local-llm/index.js";
import { selectModel, getApiKeyForProvider } from "./selection/model-selector.js";
import { ResilientLLMClient } from "./resilience/resilient-client.js";
import { ResilientImageClient } from "./resilience/resilient-image.js";
import { ResilientVideoClient } from "./resilience/resilient-video.js";

const log = createComponentLogger("llm.factory");

// ============================================
// LLM CLIENT FACTORY
// ============================================

/**
 * Create an LLM client for the specified provider.
 * Default provider is DeepSeek.
 */
export function createLLMClient(options: LLMClientOptions): ILLMClient {
  const { provider, apiKey, baseUrl } = options;
  const config = PROVIDER_CONFIGS[provider];
  if (!config) throw new Error(`Unknown provider: "${provider}". Valid providers: ${Object.keys(PROVIDER_CONFIGS).join(", ")}`);
  
  switch (provider) {
    case "deepseek":
      if (!apiKey) throw new Error("DeepSeek requires an API key");
      return new DeepSeekClient(apiKey, baseUrl || config.baseUrl);
      
    case "anthropic":
      if (!apiKey) throw new Error("Anthropic requires an API key");
      return new AnthropicClient(apiKey, baseUrl || config.baseUrl);
      
    case "openai":
      if (!apiKey) throw new Error("OpenAI requires an API key");
      return new OpenAICompatibleClient(
        "openai",
        apiKey,
        baseUrl || config.baseUrl!,
        config.defaultModel
      );
      
    case "gemini":
      if (!apiKey) throw new Error("Gemini requires an API key");
      return new GeminiClient(apiKey, baseUrl || config.baseUrl);

    case "xai":
      if (!apiKey) throw new Error("xAI requires an API key");
      return new OpenAICompatibleClient(
        "xai",
        apiKey,
        baseUrl || config.baseUrl!,
        config.defaultModel
      );

    case "local":
      return new LocalLLMClient();
      
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * Create an LLM client from a ModelSelection result.
 * This is the primary way to get a client in the new multi-provider system.
 * It automatically resolves the right API key for the selected provider.
 *
 * Returns a ResilientLLMClient that automatically tries fallback providers
 * on retryable errors (429, 500, 502, 503, 504, network failures).
 */
export function createClientForSelection(selection: ModelSelection, deviceId?: string): ILLMClient {
  const apiKey = getApiKeyForProvider(selection.provider);
  const primary = createLLMClient({
    provider: selection.provider,
    apiKey,
  });

  return new ResilientLLMClient(
    primary,
    selection.role,
    (provider, key) => createLLMClient({ provider, apiKey: key }),
    getApiKeyForProvider,
    deviceId,
  );
}

// ============================================
// IMAGE CLIENT FACTORY
// ============================================

const IMAGE_CLIENT_FACTORIES: Partial<Record<LLMProvider, (apiKey: string) => IImageClient>> = {
  gemini: (apiKey) => new GeminiImageClient(apiKey),
  openai: (apiKey) => new OpenAIImageClient(apiKey),
};

/**
 * Create an IImageClient for a provider. Returns null if the provider
 * doesn't support image generation.
 */
export function createImageClient(provider: LLMProvider, apiKey: string): IImageClient | null {
  const factory = IMAGE_CLIENT_FACTORIES[provider];
  return factory ? factory(apiKey) : null;
}

/**
 * Create a resilient IImageClient that uses the model selector's "image" role
 * and falls back through the FALLBACK_CHAINS on retryable errors.
 *
 * Usage:
 *   const client = createResilientImageClient();
 *   const result = await client.generate({ prompt: "a cat" });
 */
export function createResilientImageClient(): IImageClient {
  const selection = selectModel({ explicitRole: "image" });
  const apiKey = getApiKeyForProvider(selection.provider);
  const primary = createImageClient(selection.provider, apiKey);

  if (!primary) {
    throw new Error(`Provider ${selection.provider} does not support image generation`);
  }

  return new ResilientImageClient(primary, createImageClient);
}

// ============================================
// VIDEO CLIENT FACTORY
// ============================================

const VIDEO_CLIENT_FACTORIES: Partial<Record<LLMProvider, (apiKey: string) => IVideoClient>> = {
  gemini: (apiKey) => new GeminiVideoClient(apiKey),
};

/**
 * Create an IVideoClient for a provider. Returns null if the provider
 * doesn't support video generation.
 */
export function createVideoClient(provider: LLMProvider, apiKey: string): IVideoClient | null {
  const factory = VIDEO_CLIENT_FACTORIES[provider];
  return factory ? factory(apiKey) : null;
}

/**
 * Create a resilient IVideoClient that uses the model selector's "video" role
 * and falls back through the FALLBACK_CHAINS on retryable errors.
 */
export function createResilientVideoClient(): IVideoClient {
  const selection = selectModel({ explicitRole: "video" });
  const apiKey = getApiKeyForProvider(selection.provider);
  const primary = createVideoClient(selection.provider, apiKey);

  if (!primary) {
    throw new Error(`Provider ${selection.provider} does not support video generation`);
  }

  return new ResilientVideoClient(primary, createVideoClient);
}
