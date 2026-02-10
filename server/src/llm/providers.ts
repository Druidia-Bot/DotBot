/**
 * LLM Client Factory
 * 
 * Creates provider-specific LLM clients. Each provider implementation
 * lives in its own file for easy extension.
 * 
 * To add a new provider:
 * 1. Add it to LLMProvider in ./types.ts
 * 2. Add its config to PROVIDER_CONFIGS in ./types.ts
 * 3. Create a client class implementing ILLMClient in ./your-provider.ts
 * 4. Add a case to the switch in createLLMClient() below
 */

import {
  type LLMProvider,
  type LLMClientOptions,
  type ILLMClient,
  PROVIDER_CONFIGS,
} from "./types.js";
import { DeepSeekClient } from "./deepseek.js";
import { AnthropicClient } from "./anthropic.js";
import { OpenAICompatibleClient } from "./openai-compatible.js";
import { GeminiClient } from "./gemini.js";
import { LocalLLMClient } from "./local-llm.js";
import { getApiKeyForProvider } from "./model-selector.js";
import type { ModelSelection } from "./types.js";
import { ResilientLLMClient } from "./resilient-client.js";

// Re-export everything from types for backwards compatibility
export * from "./types.js";
export { DeepSeekClient } from "./deepseek.js";
export { AnthropicClient } from "./anthropic.js";
export { OpenAICompatibleClient } from "./openai-compatible.js";
export { GeminiClient } from "./gemini.js";
export { LocalLLMClient } from "./local-llm.js";
export { selectModel, registerApiKeys, estimateTokens, detectLargeFileContext, detectArchitectTask, getApiKeyForProvider } from "./model-selector.js";

/**
 * Create an LLM client for the specified provider.
 * Default provider is DeepSeek.
 */
export function createLLMClient(options: LLMClientOptions): ILLMClient {
  const { provider, apiKey, baseUrl } = options;
  const config = PROVIDER_CONFIGS[provider];
  
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
export function createClientForSelection(selection: ModelSelection): ILLMClient {
  const apiKey = getApiKeyForProvider(selection.provider);
  const primary = createLLMClient({
    provider: selection.provider,
    apiKey,
  });

  return new ResilientLLMClient(
    primary,
    selection.role,
    (provider, key) => createLLMClient({ provider, apiKey: key }),
    getApiKeyForProvider
  );
}

