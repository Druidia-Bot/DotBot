/**
 * LLM Provider Factory Tests
 * 
 * Validates client creation, API key validation, tier config resolution,
 * and that the barrel re-exports are intact after refactor.
 */

import { describe, it, expect } from "vitest";
import {
  createLLMClient,
  PROVIDER_CONFIGS,
  TIER_CONFIGS,
  DeepSeekClient,
  AnthropicClient,
  OpenAICompatibleClient,
  LocalLLMClient,
} from "./providers.js";

// ============================================
// FACTORY — VALID CREATION
// ============================================

describe("createLLMClient", () => {
  it("creates a DeepSeekClient with API key", () => {
    const client = createLLMClient({ provider: "deepseek", apiKey: "test-key" });
    expect(client).toBeInstanceOf(DeepSeekClient);
    expect(client.provider).toBe("deepseek");
  });

  it("creates an AnthropicClient with API key", () => {
    const client = createLLMClient({ provider: "anthropic", apiKey: "test-key" });
    expect(client).toBeInstanceOf(AnthropicClient);
    expect(client.provider).toBe("anthropic");
  });

  it("creates an OpenAI client with API key", () => {
    const client = createLLMClient({ provider: "openai", apiKey: "test-key" });
    expect(client).toBeInstanceOf(OpenAICompatibleClient);
    expect(client.provider).toBe("openai");
  });

  it("creates an xAI client with API key", () => {
    const client = createLLMClient({ provider: "xai", apiKey: "test-key" });
    expect(client).toBeInstanceOf(OpenAICompatibleClient);
    expect(client.provider).toBe("xai");
  });

  it("creates a local LLM client without API key", () => {
    const client = createLLMClient({ provider: "local" });
    expect(client).toBeInstanceOf(LocalLLMClient);
    expect(client.provider).toBe("local");
  });

  it("accepts custom baseUrl", () => {
    const client = createLLMClient({
      provider: "deepseek",
      apiKey: "test-key",
      baseUrl: "https://custom.endpoint.com",
    });
    expect(client).toBeInstanceOf(DeepSeekClient);
  });
});

// ============================================
// FACTORY — VALIDATION
// ============================================

describe("createLLMClient validation", () => {
  it("throws for DeepSeek without API key", () => {
    expect(() => createLLMClient({ provider: "deepseek" })).toThrow("DeepSeek requires an API key");
  });

  it("throws for Anthropic without API key", () => {
    expect(() => createLLMClient({ provider: "anthropic" })).toThrow("Anthropic requires an API key");
  });

  it("throws for OpenAI without API key", () => {
    expect(() => createLLMClient({ provider: "openai" })).toThrow("OpenAI requires an API key");
  });

  it("throws for xAI without API key", () => {
    expect(() => createLLMClient({ provider: "xai" })).toThrow("xAI requires an API key");
  });

  it("throws for unknown provider", () => {
    expect(() => createLLMClient({ provider: "unknown" as any, apiKey: "key" })).toThrow("Unknown provider");
  });
});

// ============================================
// PROVIDER CONFIGS
// ============================================

describe("PROVIDER_CONFIGS", () => {
  it("has config for all known providers", () => {
    expect(PROVIDER_CONFIGS.deepseek).toBeDefined();
    expect(PROVIDER_CONFIGS.anthropic).toBeDefined();
    expect(PROVIDER_CONFIGS.openai).toBeDefined();
    expect(PROVIDER_CONFIGS.xai).toBeDefined();
    expect(PROVIDER_CONFIGS.local).toBeDefined();
  });

  it("each config has required fields", () => {
    for (const [name, config] of Object.entries(PROVIDER_CONFIGS)) {
      expect(config.provider).toBe(name);
      expect(config.defaultModel).toBeTruthy();
      expect(config.models).toBeDefined();
    }
  });
});

// ============================================
// TIER CONFIGS
// ============================================

describe("TIER_CONFIGS", () => {
  it("has all three tiers", () => {
    expect(TIER_CONFIGS.fast).toBeDefined();
    expect(TIER_CONFIGS.smart).toBeDefined();
    expect(TIER_CONFIGS.powerful).toBeDefined();
  });

  it("each tier has preferredModels", () => {
    for (const tier of Object.values(TIER_CONFIGS)) {
      expect(tier.preferredModels).toBeDefined();
    }
  });

  it("tier preferredModels reference valid xAI models", () => {
    const xaiModels = Object.keys(PROVIDER_CONFIGS.xai.models);
    for (const tier of Object.values(TIER_CONFIGS)) {
      const xaiModel = tier.preferredModels.xai;
      if (xaiModel) {
        expect(xaiModels, `tier ${tier.tier} references unknown xAI model '${xaiModel}'`).toContain(xaiModel);
      }
    }
  });

  it("tier preferredModels reference valid models for all providers", () => {
    for (const tier of Object.values(TIER_CONFIGS)) {
      for (const [provider, model] of Object.entries(tier.preferredModels)) {
        const config = PROVIDER_CONFIGS[provider as keyof typeof PROVIDER_CONFIGS];
        expect(config, `provider ${provider} not found in PROVIDER_CONFIGS`).toBeDefined();
        const models = Object.keys(config.models);
        expect(models, `tier ${tier.tier} references unknown ${provider} model '${model}'`).toContain(model);
      }
    }
  });
});

