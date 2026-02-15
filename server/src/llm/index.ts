/**
 * LLM Module — Barrel Export
 *
 * Provider-agnostic LLM abstraction with role-based model selection,
 * resilient fallback, and multi-provider support.
 *
 * Structure:
 *   types.ts        — Pure type definitions (no runtime values)
 *   config.ts       — Provider configs, model roles, fallback chains
 *   factory.ts      — Client creation functions
 *   token-tracker.ts — Per-device usage recording
 *   providers/      — Provider client implementations
 *   selection/      — Model selection engine + resolution
 *   resilience/     — Retry logic + resilient client wrappers
 */

// Types
export type {
  LLMProvider,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamChunk,
  LLMProviderConfig,
  ILLMClient,
  IImageClient,
  IVideoClient,
  ModelRole,
  ModelRoleConfig,
  ModelSelection,
  ModelSelectionCriteria,
  LLMClientOptions,
  ToolDefinition,
  ToolCall,
  ImageGenerateRequest,
  ImageEditRequest,
  ImageResult,
  VideoGenerateRequest,
  VideoResult,
} from "./types.js";

// Config
export {
  PROVIDER_CONFIGS,
  MODEL_ROLE_CONFIGS,
  FALLBACK_CHAINS,
} from "./config.js";
export type { FallbackEntry } from "./config.js";

// Factory
export {
  createLLMClient,
  createClientForSelection,
  createImageClient,
  createVideoClient,
  createResilientImageClient,
  createResilientVideoClient,
} from "./factory.js";

// Selection
export {
  selectModel,
  registerApiKeys,
  getApiKeyForProvider,
  estimateTokens,
  detectLargeFileContext,
  detectArchitectTask,
} from "./selection/index.js";
export { resolveModelAndClient } from "./selection/index.js";

// Providers
export { DeepSeekClient } from "./providers/index.js";
export { AnthropicClient } from "./providers/index.js";
export { OpenAICompatibleClient, OpenAIImageClient } from "./providers/index.js";
export { GeminiClient, GeminiImageClient, GeminiVideoClient } from "./providers/index.js";
export {
  LocalLLMClient,
  isCloudReachable,
  isLocalModelReady,
  getLocalStatus,
  probeLocalModel,
  downloadLocalModel,
} from "./providers/index.js";

// Resilience
export { isRetryableError, ResilientLLMClient } from "./resilience/index.js";

// Token tracking
export { recordTokenUsage, getDeviceUsage, getAgentUsage } from "./token-tracker.js";
