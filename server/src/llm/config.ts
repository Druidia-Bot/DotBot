/**
 * LLM Configuration — Provider Configs, Model Roles, Fallback Chains
 *
 * All static configuration for the multi-provider LLM system lives here.
 * Types are in ./types.ts. Runtime logic (selection, resilience, factories) is elsewhere.
 */

import type {
  LLMProvider,
  LLMProviderConfig,
  ModelRole,
  ModelRoleConfig,
} from "./types.js";

// ============================================
// PROVIDER CONFIGURATIONS
// ============================================

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

// ============================================
// MODEL ROLE CONFIGS (task-based selection)
// ============================================

export const MODEL_ROLE_CONFIGS: Record<ModelRole, ModelRoleConfig> = {
  workhorse: {
    role: "workhorse",
    provider: "deepseek",
    model: "deepseek-chat",
    temperature: 0.0,
    maxTokens: 4096,
    contextWindow: 64000,
    description: "DeepSeek V3.2 — fast, cheap, handles 98% of tasks",
  },
  deep_context: {
    role: "deep_context",
    provider: "gemini",
    model: "gemini-3-pro-preview",
    temperature: 0.3,
    maxTokens: 8192,
    contextWindow: 1000000,
    description: "Gemini 3 Pro — 1M context for massive prompts, video, large files",
  },
  architect: {
    role: "architect",
    provider: "anthropic",
    model: "claude-opus-4-6",
    temperature: 0.0,
    maxTokens: 8192,
    contextWindow: 1000000,
    description: "Claude Opus 4.6 — complex system design, planning, second opinions",
  },
  local: {
    role: "local",
    provider: "local",
    model: "qwen2.5-0.5b-instruct-q4_k_m",
    temperature: 0.3,
    maxTokens: 1024,
    contextWindow: 32000,
    description: "Qwen 2.5 0.5B — offline fallback for basic tasks",
  },
  gui_fast: {
    role: "gui_fast",
    provider: "gemini",
    model: "gemini-2.5-flash",
    temperature: 0.0,
    maxTokens: 4096,
    contextWindow: 1000000,
    description: "Gemini 2.5 Flash — low-latency GUI tool loop (fast decisions, cheap)",
  },
  intake: {
    role: "intake",
    provider: "xai",
    model: "grok-4-1-fast-non-reasoning",
    temperature: 0.0,
    maxTokens: 4096,
    contextWindow: 131072,
    description: "Grok 4.1 Fast — low-latency intake classification and routing",
  },
  assistant: {
    role: "assistant",
    provider: "xai",
    model: "grok-4-1-fast-non-reasoning",
    temperature: 0.3,
    maxTokens: 4096,
    contextWindow: 131072,
    description: "Grok 4.1 Fast — conversational assistant, fast non-reasoning",
  },
  image: {
    role: "image",
    provider: "gemini",
    model: "gemini-3-pro-image-preview",
    temperature: 0.5,
    maxTokens: 8192,
    contextWindow: 32000,
    description: "Gemini 3 Pro Image — native image generation via responseModalities",
  },
  video: {
    role: "video",
    provider: "gemini",
    model: "veo-3.1-fast-generate-preview",
    temperature: 0.3,
    maxTokens: 8192,
    contextWindow: 32000,
    description: "Veo 3.1 Fast — video generation via Gemini API",
  },
};

// ============================================
// FALLBACK CHAINS
// ============================================

export interface FallbackEntry {
  provider: LLMProvider;
  model: string;
  temperature: number;
  maxTokens: number;
}

/**
 * Ordered fallback chains per role. Includes ALL providers (primary + alternates).
 * Used by:
 *   - getFallback() at selection time: skips primary, picks first with an API key
 *   - getRuntimeFallbacks() in resilient-client: filters out the failed provider
 *
 * Order matters — first match wins.
 */
export const FALLBACK_CHAINS: Record<ModelRole, FallbackEntry[]> = {
  workhorse: [
    { provider: "deepseek", model: "deepseek-chat", temperature: 0.0, maxTokens: 4096 },
    { provider: "gemini", model: "gemini-2.5-flash", temperature: 0.0, maxTokens: 4096 },
    { provider: "openai", model: "gpt-4o-mini", temperature: 0.0, maxTokens: 4096 },
    { provider: "anthropic", model: "claude-3-5-haiku-20241022", temperature: 0.0, maxTokens: 4096 },
    { provider: "xai", model: "grok-4-1-fast-reasoning", temperature: 0.0, maxTokens: 4096 },
    { provider: "local", model: "qwen2.5-0.5b-instruct-q4_k_m", temperature: 0.3, maxTokens: 1024 },
  ],
  deep_context: [
    { provider: "gemini", model: "gemini-3-pro-preview", temperature: 0.3, maxTokens: 8192 },
    { provider: "anthropic", model: "claude-opus-4-6", temperature: 0.3, maxTokens: 8192 },
    { provider: "xai", model: "grok-4-1-fast-non-reasoning", temperature: 0.3, maxTokens: 8192 },
    { provider: "deepseek", model: "deepseek-chat", temperature: 0.0, maxTokens: 4096 },
  ],
  architect: [
    { provider: "anthropic", model: "claude-opus-4-6", temperature: 0.0, maxTokens: 8192 },
    { provider: "deepseek", model: "deepseek-reasoner", temperature: 0.0, maxTokens: 8192 },
    { provider: "gemini", model: "gemini-3-pro-preview", temperature: 0.0, maxTokens: 8192 },
    { provider: "xai", model: "grok-4-1-fast-reasoning", temperature: 0.0, maxTokens: 8192 },
  ],
  local: [
    { provider: "local", model: "qwen2.5-0.5b-instruct-q4_k_m", temperature: 0.3, maxTokens: 1024 },
    { provider: "deepseek", model: "deepseek-chat", temperature: 0.3, maxTokens: 1024 },
  ],
  gui_fast: [
    { provider: "gemini", model: "gemini-2.5-flash", temperature: 0.0, maxTokens: 4096 },
    { provider: "openai", model: "gpt-4o-mini", temperature: 0.0, maxTokens: 4096 },
    { provider: "deepseek", model: "deepseek-chat", temperature: 0.0, maxTokens: 4096 },
    { provider: "xai", model: "grok-4-1-fast-non-reasoning", temperature: 0.0, maxTokens: 4096 },
    { provider: "local", model: "qwen2.5-0.5b-instruct-q4_k_m", temperature: 0.3, maxTokens: 1024 },
  ],
  intake: [
    { provider: "xai", model: "grok-4-1-fast-non-reasoning", temperature: 0.0, maxTokens: 4096 },
    { provider: "gemini", model: "gemini-2.5-flash", temperature: 0.0, maxTokens: 4096 },
    { provider: "deepseek", model: "deepseek-chat", temperature: 0.0, maxTokens: 4096 },
    { provider: "openai", model: "gpt-4o-mini", temperature: 0.0, maxTokens: 4096 },
    { provider: "local", model: "qwen2.5-0.5b-instruct-q4_k_m", temperature: 0.3, maxTokens: 1024 },
  ],
  assistant: [
    { provider: "xai", model: "grok-4-1-fast-non-reasoning", temperature: 0.3, maxTokens: 4096 },
    { provider: "gemini", model: "gemini-2.5-flash", temperature: 0.3, maxTokens: 4096 },
    { provider: "deepseek", model: "deepseek-chat", temperature: 0.3, maxTokens: 4096 },
    { provider: "openai", model: "gpt-4o-mini", temperature: 0.3, maxTokens: 4096 },
    { provider: "local", model: "qwen2.5-0.5b-instruct-q4_k_m", temperature: 0.3, maxTokens: 1024 },
  ],
  image: [
    { provider: "gemini", model: "gemini-3-pro-image-preview", temperature: 0.5, maxTokens: 8192 },
    { provider: "openai", model: "gpt-image-1.5", temperature: 0.5, maxTokens: 4096 },
  ],
  video: [
    { provider: "gemini", model: "veo-3.1-fast-generate-preview", temperature: 0.3, maxTokens: 8192 },
    { provider: "xai", model: "grok-imagine-video", temperature: 0.3, maxTokens: 8192 },
  ],
};
