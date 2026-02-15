/**
 * LLM Type Definitions
 *
 * Pure types and interfaces for the provider-agnostic LLM system.
 * No runtime values — configuration constants live in ./config.ts.
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
  /** JSON Schema for structured output. When provided alongside responseFormat: "json_object",
   *  providers that support json_schema mode (OpenAI, xAI, DeepSeek) will enforce the schema.
   *  The schema object should include { name: string, schema: Record<string, unknown> }. */
  responseSchema?: { name: string; schema: Record<string, unknown> };
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
export type ModelRole = "workhorse" | "deep_context" | "architect" | "local" | "gui_fast" | "intake" | "assistant" | "image" | "video";

export interface ModelRoleConfig {
  role: ModelRole;
  provider: LLMProvider;
  model: string;
  temperature: number;
  maxTokens: number;
  contextWindow: number;
  description: string;
}

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
  /** Explicit role override (e.g. from receptionist decision) */
  explicitRole?: ModelRole;
  /** Direct model override from local persona (highest priority) */
  personaModelOverride?: {
    provider?: LLMProvider;
    model?: string;
  };
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

// ============================================
// IMAGE CLIENT INTERFACE
// ============================================

export interface ImageGenerateRequest {
  prompt: string;
  model?: string;
  aspectRatio?: string;
  size?: string;
  referenceImages?: Array<{ mimeType: string; data: string }>;
}

export interface ImageEditRequest {
  prompt: string;
  model?: string;
  sourceImage: { mimeType: string; data: string };
  aspectRatio?: string;
  size?: string;
  referenceImages?: Array<{ mimeType: string; data: string }>;
}

export interface ImageResult {
  base64: string;
  mimeType: string;
  description?: string;
}

export interface IImageClient {
  provider: LLMProvider;

  generate(request: ImageGenerateRequest): Promise<ImageResult>;

  edit(request: ImageEditRequest): Promise<ImageResult>;
}

// ============================================
// VIDEO CLIENT INTERFACE
// ============================================

export interface VideoGenerateRequest {
  prompt: string;
  model?: string;
  aspectRatio?: string;
  durationSeconds?: number;
  referenceImage?: { mimeType: string; data: string };
}

export interface VideoResult {
  base64: string;
  mimeType: string;
  durationSeconds?: number;
  description?: string;
}

export interface IVideoClient {
  provider: LLMProvider;

  generate(request: VideoGenerateRequest): Promise<VideoResult>;
}
