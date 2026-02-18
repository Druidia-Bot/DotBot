/**
 * LLM Provider Factory Tests
 * 
 * Validates client creation, API key validation, tier config resolution,
 * and that the barrel re-exports are intact after refactor.
 */

import { describe, it, expect } from "vitest";
import { createLLMClient } from "../factory.js";
import { PROVIDER_CONFIGS } from "../providers.js";
import { DeepSeekClient } from "../providers/deepseek.js";
import { AnthropicClient } from "../providers/anthropic.js";
import { OpenAICompatibleClient } from "../providers/openai-compatible/index.js";
import { LocalLLMClient } from "../providers/local-llm/index.js";

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


