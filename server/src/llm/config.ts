/**
 * LLM Configuration — Model Roles + Fallback Chains
 *
 * Role configs define which provider/model handles each task type.
 * Fallback chains list alternatives when the primary provider is unavailable.
 * Provider definitions (base URLs, models, costs) live in ./providers.ts.
 */

import type {
  LLMProvider,
  ModelRole,
  ModelRoleConfig,
} from "./types.js";

// ============================================
// MODEL ROLE CONFIGS (task-based selection)
// ============================================

export const MODEL_ROLE_CONFIGS: Record<ModelRole, ModelRoleConfig> = {
  workhorse: {
    role: "workhorse",
    provider: "xai",
    model: "grok-4-1-fast-reasoning",
    temperature: 0.0,
    maxTokens: 4096,
    contextWindow: 131072,
    description: "Grok 4.1 Fast Thinking — reasoning-enabled workhorse for medium-complexity tasks",
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
 * Ordered fallback chains per role. Does NOT include the primary provider
 * (that's in MODEL_ROLE_CONFIGS). These are alternatives only.
 * Used by:
 *   - getFallback() at selection time: picks first with an API key
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
    { provider: "local", model: "qwen2.5-0.5b-instruct-q4_k_m", temperature: 0.3, maxTokens: 1024 },
  ],
  deep_context: [
    { provider: "anthropic", model: "claude-opus-4-6", temperature: 0.3, maxTokens: 8192 },
    { provider: "xai", model: "grok-4-1-fast-non-reasoning", temperature: 0.3, maxTokens: 8192 },
    { provider: "deepseek", model: "deepseek-chat", temperature: 0.0, maxTokens: 4096 },
  ],
  architect: [
    { provider: "deepseek", model: "deepseek-reasoner", temperature: 0.0, maxTokens: 8192 },
    { provider: "gemini", model: "gemini-3-pro-preview", temperature: 0.0, maxTokens: 8192 },
    { provider: "xai", model: "grok-4-1-fast-reasoning", temperature: 0.0, maxTokens: 8192 },
  ],
  local: [
    { provider: "deepseek", model: "deepseek-chat", temperature: 0.3, maxTokens: 1024 },
  ],
  gui_fast: [
    { provider: "openai", model: "gpt-4o-mini", temperature: 0.0, maxTokens: 4096 },
    { provider: "deepseek", model: "deepseek-chat", temperature: 0.0, maxTokens: 4096 },
    { provider: "xai", model: "grok-4-1-fast-non-reasoning", temperature: 0.0, maxTokens: 4096 },
    { provider: "local", model: "qwen2.5-0.5b-instruct-q4_k_m", temperature: 0.3, maxTokens: 1024 },
  ],
  intake: [
    { provider: "gemini", model: "gemini-2.5-flash", temperature: 0.0, maxTokens: 4096 },
    { provider: "deepseek", model: "deepseek-chat", temperature: 0.0, maxTokens: 4096 },
    { provider: "openai", model: "gpt-4o-mini", temperature: 0.0, maxTokens: 4096 },
    { provider: "local", model: "qwen2.5-0.5b-instruct-q4_k_m", temperature: 0.3, maxTokens: 1024 },
  ],
  assistant: [
    { provider: "gemini", model: "gemini-2.5-flash", temperature: 0.3, maxTokens: 4096 },
    { provider: "deepseek", model: "deepseek-chat", temperature: 0.3, maxTokens: 4096 },
    { provider: "openai", model: "gpt-4o-mini", temperature: 0.3, maxTokens: 4096 },
    { provider: "local", model: "qwen2.5-0.5b-instruct-q4_k_m", temperature: 0.3, maxTokens: 1024 },
  ],
  image: [
    { provider: "openai", model: "gpt-image-1.5", temperature: 0.5, maxTokens: 4096 },
  ],
  video: [
    { provider: "xai", model: "grok-imagine-video", temperature: 0.3, maxTokens: 8192 },
  ],
};
