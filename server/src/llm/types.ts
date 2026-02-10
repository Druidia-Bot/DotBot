/**
 * LLM Type Definitions & Provider Configuration
 * 
 * All interfaces, configs, and tier mappings for the provider-agnostic LLM system.
 */

// ============================================
// CORE TYPES
// ============================================

export type LLMProvider = "deepseek" | "anthropic" | "openai" | "gemini" | "xai" | "local";

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Tool calls made by the assistant (only on assistant messages) */
  tool_calls?: ToolCall[];
  /** ID of the tool call this message is a result for (only on tool messages) */
  tool_call_id?: string;
  /** Base64-encoded images attached to this message (e.g., screenshots from gui tools).
   *  LLM provider formatters convert these to the correct API format. */
  images?: Array<{ base64: string; media_type: "image/jpeg" | "image/png" }>;
  /** Chain-of-thought reasoning from thinking mode (DeepSeek). Must be passed back
   *  to the API between tool call turns. Cleared when a new user question starts. */
  reasoning_content?: string;
}

// ============================================
// NATIVE FUNCTION CALLING TYPES
// ============================================

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, any>; // JSON Schema
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface LLMRequestOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  /** Native function calling: tool definitions to pass to the API */
  tools?: ToolDefinition[];
  /** Force structured JSON output from the model (supported by DeepSeek, OpenAI) */
  responseFormat?: "json_object" | "text";
  /** Enable chain-of-thought thinking mode (DeepSeek). The model reasons before
   *  answering, producing a separate reasoning_content field. Temperature/top_p
   *  are ignored when thinking is enabled. */
  thinking?: boolean;
}

export interface LLMResponse {
  content: string;
  model: string;
  provider: LLMProvider;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  /** Structured tool calls from native function calling (if any) */
  toolCalls?: ToolCall[];
  /** Chain-of-thought reasoning from thinking mode (DeepSeek). */
  reasoningContent?: string;
}

export interface LLMStreamChunk {
  content: string;
  done: boolean;
}

export interface LLMProviderConfig {
  provider: LLMProvider;
  apiKey?: string;
  baseUrl?: string;
  defaultModel: string;
  models: Record<string, {
    name: string;
    contextWindow: number;
    costPer1kInput?: number;
    costPer1kOutput?: number;
  }>;
}

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
// MODEL ROLES (task-based selection)
// ============================================

/**
 * Model roles map to specific providers and models based on task characteristics.
 * Unlike the old tier system (fast/smart/powerful), roles represent WHY a model
 * is chosen, not just how capable it is.
 *
 * - workhorse:    DeepSeek V3.2 — 98% of tasks. Fast, cheap, very capable.
 * - deep_context: Gemini 3 Pro — 1M token context. Video, large PDFs, huge codebases.
 * - architect:    Claude Opus 4.6 — Complex system design, second opinions, planning.
 * - local:        Qwen 2.5 0.5B via node-llama-cpp — Offline fallback for basic tasks.
 */
export type ModelRole = "workhorse" | "deep_context" | "architect" | "local" | "gui_fast";

export interface ModelRoleConfig {
  role: ModelRole;
  provider: LLMProvider;
  model: string;
  temperature: number;
  maxTokens: number;
  contextWindow: number;
  description: string;
}

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
};

// ============================================
// MODEL SELECTION CRITERIA
// ============================================

/** Input to the model selection function */
export interface ModelSelectionCriteria {
  /** Estimated total token count (prompt + context + expected output) */
  estimatedTokens?: number;
  /** Whether the request involves large files (video, PDF, large codebases) */
  hasLargeFiles?: boolean;
  /** Whether this is an architect-level task (complex design, planning, second opinion) */
  isArchitectTask?: boolean;
  /** Whether the receptionist flagged this for a second opinion / review */
  isSecondOpinion?: boolean;
  /** Whether the system is offline (no cloud access) */
  isOffline?: boolean;
  /** Persona's declared model tier (backwards compat) */
  personaModelTier?: ModelTier;
  /** Explicit role override (e.g. from receptionist decision) */
  explicitRole?: ModelRole;
}

/** Output of the model selection function */
export interface ModelSelection {
  role: ModelRole;
  provider: LLMProvider;
  model: string;
  temperature: number;
  maxTokens: number;
  reason: string;
}

// ============================================
// MODEL TIER MAPPING (legacy, provider-agnostic)
// ============================================

/** @deprecated Use ModelRole and MODEL_ROLE_CONFIGS instead */
export type ModelTier = "fast" | "smart" | "powerful";

export interface TierConfig {
  tier: ModelTier;
  temperature: number;
  maxTokens: number;
  preferredModels: Partial<Record<LLMProvider, string>>;
}

/** @deprecated Use MODEL_ROLE_CONFIGS instead. Maps old tiers to roles for backwards compat. */
export const TIER_TO_ROLE: Record<ModelTier, ModelRole> = {
  fast: "workhorse",
  smart: "workhorse",
  powerful: "architect",
};

export const TIER_CONFIGS: Record<ModelTier, TierConfig> = {
  fast: {
    tier: "fast",
    temperature: 0.0,
    maxTokens: 2048,
    preferredModels: {
      deepseek: "deepseek-chat",
      anthropic: "claude-3-5-haiku-20241022",
      openai: "gpt-4o-mini",
      gemini: "gemini-2.5-flash",
      xai: "grok-4-1-fast-non-reasoning",
      local: "qwen2.5-0.5b-instruct-q4_k_m"
    }
  },
  smart: {
    tier: "smart",
    temperature: 0.0,
    maxTokens: 4096,
    preferredModels: {
      deepseek: "deepseek-chat",
      anthropic: "claude-sonnet-4-20250514",
      openai: "gpt-4o",
      gemini: "gemini-3-pro-preview",
      xai: "grok-4-1-fast-reasoning",
      local: "qwen2.5-0.5b-instruct-q4_k_m"
    }
  },
  powerful: {
    tier: "powerful",
    temperature: 0.0,
    maxTokens: 8192,
    preferredModels: {
      deepseek: "deepseek-reasoner",
      anthropic: "claude-opus-4-6",
      openai: "gpt-4o",
      gemini: "gemini-3-pro-preview",
      xai: "grok-4-1-fast-reasoning",
      local: "qwen2.5-0.5b-instruct-q4_k_m"
    }
  }
};

// ============================================
// LLM CLIENT INTERFACE
// ============================================

export interface ILLMClient {
  provider: LLMProvider;
  
  chat(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse>;
  
  stream(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): AsyncGenerator<LLMStreamChunk, void, unknown>;
}

export interface LLMClientOptions {
  provider: LLMProvider;
  apiKey?: string;
  baseUrl?: string;
}
