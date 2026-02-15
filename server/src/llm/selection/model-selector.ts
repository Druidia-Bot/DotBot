/**
 * Model Selection Engine
 * 
 * Determines which model (provider + model ID) to use for a given task
 * based on standardized criteria. This replaces the old tier-based system
 * with a task-aware selection that uses multiple providers simultaneously.
 *
 * Decision tree:
 * 1. Explicit role override? → use it
 * 2. Offline? → local (Qwen 2.5 0.5B via node-llama-cpp)
 * 3. Massive context needed (>50K tokens, large files, video)? → deep_context (Gemini 3 Pro)
 * 4. Architect-level task (complex design, planning, second opinion)? → architect (Claude Opus 4.6)
 * 5. Everything else → workhorse (DeepSeek V3.2)
 *
 * Fallback chain: if the selected provider's API key is missing,
 * fall back to the next best option.
 */

import { createComponentLogger } from "#logging.js";
import type {
  ModelRole,
  ModelSelection,
  ModelSelectionCriteria,
  LLMProvider,
} from "../types.js";
import { MODEL_ROLE_CONFIGS, PROVIDER_CONFIGS, FALLBACK_CHAINS } from "../config.js";
import type { FallbackEntry } from "../config.js";

const log = createComponentLogger("model-selector");

// ============================================
// THRESHOLDS
// ============================================

/** Token count above which we escalate to deep_context (Gemini 3 Pro) */
const DEEP_CONTEXT_TOKEN_THRESHOLD = 50_000;

/** Token count above which workhorse can't handle it (DeepSeek context = 64K) */
const WORKHORSE_MAX_TOKENS = 60_000;

// ============================================
// AVAILABLE API KEYS (set at startup)
// ============================================

const availableKeys: Partial<Record<LLMProvider, string>> = {};

/**
 * Register available API keys so the selector knows which providers are usable.
 * Call once at server startup.
 */
export function registerApiKeys(keys: Partial<Record<LLMProvider, string>>): void {
  // Clear all previous keys — this is a full replacement, not a merge
  for (const k of Object.keys(availableKeys)) {
    delete availableKeys[k as LLMProvider];
  }
  for (const [provider, key] of Object.entries(keys)) {
    if (key) {
      availableKeys[provider as LLMProvider] = key;
    }
  }
  log.info("Registered API keys", {
    providers: Object.keys(availableKeys),
  });
}

/**
 * Check if a provider has an API key available.
 * Local provider doesn't need a key.
 */
function isProviderAvailable(provider: LLMProvider): boolean {
  if (provider === "local") return true; // No key needed
  return !!availableKeys[provider];
}

/**
 * Get the API key for a provider (or empty string for local).
 */
export function getApiKeyForProvider(provider: LLMProvider): string {
  if (provider === "local") return "";
  return availableKeys[provider] || "";
}

// ============================================
// SELECTION ENGINE
// ============================================

/**
 * Select the best model for a task based on standardized criteria.
 *
 * This is THE function that determines which model handles each request.
 * Every LLM call in the system should go through this selector.
 */
export function selectModel(criteria: ModelSelectionCriteria): ModelSelection {
  // 0. Persona model override (NEW - highest priority for local personas)
  if (criteria.personaModelOverride) {
    const override = criteria.personaModelOverride;

    // Specific model + provider requested
    if (override.model && override.provider) {
      if (isProviderAvailable(override.provider)) {
        const config = PROVIDER_CONFIGS[override.provider];
        const modelConfig = config.models[override.model];

        if (modelConfig) {
          log.info(`Model selected: persona override (specific)`, {
            provider: override.provider,
            model: override.model,
            reason: `local persona override: ${override.provider}/${override.model}`,
          });

          return {
            role: "workhorse", // Use workhorse role by default for overrides
            provider: override.provider,
            model: override.model,
            temperature: 0.3,
            maxTokens: 4096,
            reason: `local persona override: ${override.provider}/${override.model}`,
          };
        }
      }
      // Fall through to tier/provider if specific model unavailable
    }

    // Provider requested (use default model for that provider)
    if (override.provider && isProviderAvailable(override.provider)) {
      const config = PROVIDER_CONFIGS[override.provider];
      log.info(`Model selected: persona override (provider)`, {
        provider: override.provider,
        model: config.defaultModel,
        reason: `local persona override: ${override.provider} (default model)`,
      });

      return {
        role: "workhorse",
        provider: override.provider,
        model: config.defaultModel,
        temperature: 0.3,
        maxTokens: 4096,
        reason: `local persona override: ${override.provider} (default model)`,
      };
    }

  }

  // 1. Explicit role override (e.g. receptionist says "use architect")
  if (criteria.explicitRole) {
    return resolveRole(criteria.explicitRole, `explicit override: ${criteria.explicitRole}`);
  }

  // 2. Offline → local
  if (criteria.isOffline) {
    return resolveRole("local", "system is offline → local fallback");
  }

  // 3. Massive context → deep_context (Gemini 3 Pro)
  if (criteria.hasLargeFiles) {
    return resolveRole("deep_context", "large files detected (video/PDF/codebase) → 1M context");
  }
  if (criteria.estimatedTokens && criteria.estimatedTokens > DEEP_CONTEXT_TOKEN_THRESHOLD) {
    return resolveRole("deep_context", `estimated ${criteria.estimatedTokens} tokens exceeds ${DEEP_CONTEXT_TOKEN_THRESHOLD} threshold → 1M context`);
  }

  // 4. Architect-level task → architect (Claude Opus 4.6)
  if (criteria.isArchitectTask) {
    return resolveRole("architect", "complex system design / architecture task");
  }
  if (criteria.isSecondOpinion) {
    return resolveRole("architect", "second opinion / review requested");
  }

  // 5. Safety guard: if estimated tokens exceed workhorse context window, escalate
  if (criteria.estimatedTokens && criteria.estimatedTokens > WORKHORSE_MAX_TOKENS) {
    return resolveRole("deep_context", `estimated ${criteria.estimatedTokens} tokens exceeds workhorse limit (${WORKHORSE_MAX_TOKENS}) → deep_context`);
  }

  // 7. Default → workhorse (DeepSeek V3.2)
  return resolveRole("workhorse", "default → DeepSeek V3.2 workhorse");
}

/**
 * Resolve a role to a concrete ModelSelection, applying fallbacks
 * if the preferred provider's API key is missing.
 */
function resolveRole(role: ModelRole, reason: string): ModelSelection {
  const config = MODEL_ROLE_CONFIGS[role];

  // Check if preferred provider is available
  if (isProviderAvailable(config.provider)) {
    log.info(`Model selected: ${role}`, { provider: config.provider, model: config.model, reason });
    return {
      role,
      provider: config.provider,
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      reason,
    };
  }

  // Fallback chain
  const fallback = getFallback(role);
  if (fallback) {
    const fallbackReason = `${reason} [FALLBACK: ${config.provider} unavailable → ${fallback.provider}]`;
    log.warn(`Falling back from ${config.provider} to ${fallback.provider}`, { role, reason: fallbackReason });
    return {
      role,
      provider: fallback.provider,
      model: fallback.model,
      temperature: fallback.temperature,
      maxTokens: fallback.maxTokens,
      reason: fallbackReason,
    };
  }

  // Last resort: return the config anyway (will fail at API call time with a clear error)
  log.error(`No available provider for role ${role}`, { preferredProvider: config.provider });
  return {
    role,
    provider: config.provider,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    reason: `${reason} [WARNING: no API key for ${config.provider}]`,
  };
}

/**
 * Selection-time fallback: find the first available provider in the chain,
 * skipping the role's primary provider (which was already tried).
 */
function getFallback(role: ModelRole): FallbackEntry | null {
  const primary = MODEL_ROLE_CONFIGS[role]?.provider;
  const chain = FALLBACK_CHAINS[role] || [];
  for (const option of chain) {
    if (option.provider !== primary && isProviderAvailable(option.provider)) {
      return option;
    }
  }
  return null;
}

// ============================================
// UTILITY: TOKEN ESTIMATION
// ============================================

/**
 * Rough token estimate from a string. ~4 chars per token for English.
 * This is intentionally approximate — it's used for routing decisions,
 * not billing.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Check if content likely contains large file references that need deep context.
 * Looks for common indicators in the prompt or tool results.
 */
export function detectLargeFileContext(text: string): boolean {
  const lower = text.toLowerCase();
  const indicators = [
    /\b(analyze|read|review|summarize|parse|extract|process|check|look|scan|inspect)\b.*\.(mp4|avi|mov|mkv|webm)\b/, // video files with action verb
    /\b(analyze|read|review|summarize|parse|extract|process|check|look|scan|inspect)\b.*\.(pdf)\b/, // PDF with action verb
    /\.(pdf|mp4|avi|mov|mkv|webm)\b.*\b(analyze|read|review|summarize|parse|extract|process|check|look|scan|inspect)\b/, // file then action verb
    /\b(entire|whole|full)\s+(codebase|repository|repo|project)\b/,
    /\b(analyze|review|watch|transcribe|check)\s+(this|the|a)\s+(video|recording|footage)\b/,
    /\btoken(s)?\s*[:=]\s*\d{5,}/,       // explicit large token counts
    /\b\d{3,}\s*pages?\b/,               // "200 pages", "300-page"
  ];
  return indicators.some(p => p.test(lower));
}

/**
 * Check if a task is architect-level based on keywords in the prompt.
 * Used as a hint — the receptionist can also flag this explicitly.
 */
export function detectArchitectTask(text: string): boolean {
  const lower = text.toLowerCase();
  const indicators = [
    /\b(architect|architecture|system\s+design|design\s+pattern)\b/,
    /\b(second\s+look|second\s+opinion|review\s+(the|this)\s+(design|architecture|approach))\b/,
    /\b(refactor|redesign|restructure)\s+(the\s+)?(entire|whole|system|codebase)\b/,
    /\b(trade.?offs?|pros?\s+and\s+cons?|evaluate\s+(approaches?|options?|alternatives?))\b/,
  ];
  return indicators.some(p => p.test(lower));
}
