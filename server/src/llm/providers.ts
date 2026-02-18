/**
 * LLM Provider Configurations
 *
 * Static provider definitions: base URLs, available models, context windows, costs.
 * Separated from role configs and fallback chains (config.ts) for clarity.
 */

import type { LLMProvider, LLMProviderConfig } from "./types.js";

export const PROVIDER_CONFIGS: Record<LLMProvider, Omit<LLMProviderConfig, "apiKey">> = {
  deepseek: {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
    models: {
      "deepseek-chat": {
        name: "DeepSeek V3.2",
        contextWindow: 64000,
        costPer1kInput: 0.00014,
        costPer1kOutput: 0.00028
      },
      "deepseek-reasoner": {
        name: "DeepSeek V3.2 Reasoner",
        contextWindow: 64000,
        costPer1kInput: 0.00055,
        costPer1kOutput: 0.00219
      }
    }
  },
  anthropic: {
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-opus-4-6",
    models: {
      "claude-opus-4-6": {
        name: "Claude Opus 4.6",
        contextWindow: 1000000,
        costPer1kInput: 0.015,
        costPer1kOutput: 0.075
      },
      "claude-sonnet-4-20250514": {
        name: "Claude Sonnet 4",
        contextWindow: 200000,
        costPer1kInput: 0.003,
        costPer1kOutput: 0.015
      },
      "claude-3-5-haiku-20241022": {
        name: "Claude 3.5 Haiku",
        contextWindow: 200000,
        costPer1kInput: 0.001,
        costPer1kOutput: 0.005
      }
    }
  },
  openai: {
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
    models: {
      "gpt-4o": {
        name: "GPT-4o",
        contextWindow: 128000,
        costPer1kInput: 0.005,
        costPer1kOutput: 0.015
      },
      "gpt-4o-mini": {
        name: "GPT-4o Mini",
        contextWindow: 128000,
        costPer1kInput: 0.00015,
        costPer1kOutput: 0.0006
      }
    }
  },
  gemini: {
    provider: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    defaultModel: "gemini-3-pro-preview",
    models: {
      "gemini-3-pro-preview": {
        name: "Gemini 3 Pro",
        contextWindow: 1000000,
        costPer1kInput: 0.00125,
        costPer1kOutput: 0.005
      },
      "gemini-2.5-flash": {
        name: "Gemini 2.5 Flash",
        contextWindow: 1000000,
        costPer1kInput: 0.00015,
        costPer1kOutput: 0.0006
      },
      "gemini-3-pro-image-preview": {
        name: "Gemini 3 Pro Image",
        contextWindow: 32000,
        costPer1kInput: 0.00125,
        costPer1kOutput: 0.005
      },
      "veo-3.1-fast-generate-preview": {
        name: "Veo 3.1 Fast",
        contextWindow: 32000,
        costPer1kInput: 0.002,
        costPer1kOutput: 0.008
      }
    }
  },
  xai: {
    provider: "xai",
    baseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-4-1-fast-reasoning",
    models: {
      "grok-4-1-fast-reasoning": {
        name: "Grok 4.1 Fast Reasoning",
        contextWindow: 131072,
        costPer1kInput: 0.003,
        costPer1kOutput: 0.015
      },
      "grok-4-1-fast-non-reasoning": {
        name: "Grok 4.1 Fast Non-Reasoning",
        contextWindow: 131072,
        costPer1kInput: 0.001,
        costPer1kOutput: 0.005
      },
      "grok-imagine-video": {
        name: "Grok Imagine Video",
        contextWindow: 32000,
        costPer1kInput: 0.002,
        costPer1kOutput: 0.008
      }
    }
  },
  local: {
    provider: "local",
    defaultModel: "qwen2.5-0.5b-instruct-q4_k_m",
    models: {
      "qwen2.5-0.5b-instruct-q4_k_m": {
        name: "Qwen 2.5 0.5B Instruct (Q4_K_M)",
        contextWindow: 32000
      }
    }
  }
};
