/**
 * Deployment-level integration tests for the local LLM system.
 *
 * These tests verify:
 * - LocalLLMClient implements ILLMClient correctly
 * - Provider wiring (createLLMClient, createClientForSelection)
 * - Model selection routes to "local" provider correctly
 * - Fallback chains include local as last resort
 * - Cloud connectivity check returns a boolean
 * - PROVIDER_CONFIGS consistency after ollama→local rename
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createLLMClient, createClientForSelection } from "../factory.js";
import { MODEL_ROLE_CONFIGS } from "../config.js";
import { PROVIDER_CONFIGS } from "../providers.js";
import { LocalLLMClient, isCloudReachable, isLocalModelReady, getLocalStatus } from "../providers/local-llm/index.js";
import { selectModel, registerApiKeys } from "../selection/model-selector.js";

// ============================================
// LOCAL LLM CLIENT — INTERFACE COMPLIANCE
// ============================================

describe("LocalLLMClient", () => {
  it("implements ILLMClient with provider = 'local'", () => {
    const client = new LocalLLMClient();
    expect(client.provider).toBe("local");
    expect(typeof client.chat).toBe("function");
    expect(typeof client.stream).toBe("function");
  });

  it("is returned by createLLMClient for local provider", () => {
    const client = createLLMClient({ provider: "local" });
    expect(client).toBeInstanceOf(LocalLLMClient);
    expect(client.provider).toBe("local");
  });

  it("is returned by createClientForSelection for local role (wrapped in ResilientLLMClient)", () => {
    registerApiKeys({ deepseek: "sk-test" });
    const selection = selectModel({ isOffline: true });
    const client = createClientForSelection(selection);
    // createClientForSelection now wraps in ResilientLLMClient for runtime fallback
    expect(client.provider).toBe("local");
  });
});

// ============================================
// PROVIDER CONFIG CONSISTENCY
// ============================================

describe("PROVIDER_CONFIGS — local provider", () => {
  it("has a 'local' entry (not 'ollama')", () => {
    expect(PROVIDER_CONFIGS.local).toBeDefined();
    expect((PROVIDER_CONFIGS as any).ollama).toBeUndefined();
  });

  it("local provider has correct shape", () => {
    const config = PROVIDER_CONFIGS.local;
    expect(config.provider).toBe("local");
    expect(config.defaultModel).toBe("qwen2.5-0.5b-instruct-q4_k_m");
    expect(config.models).toBeDefined();
    expect(config.models["qwen2.5-0.5b-instruct-q4_k_m"]).toBeDefined();
  });

  it("no provider config references 'ollama'", () => {
    for (const [key, config] of Object.entries(PROVIDER_CONFIGS)) {
      expect(key).not.toBe("ollama");
      expect(config.provider).not.toBe("ollama");
    }
  });
});

describe("MODEL_ROLE_CONFIGS — local role", () => {
  it("local role maps to local provider", () => {
    expect(MODEL_ROLE_CONFIGS.local.provider).toBe("local");
    expect(MODEL_ROLE_CONFIGS.local.model).toBe("qwen2.5-0.5b-instruct-q4_k_m");
  });

  it("all four roles are defined", () => {
    expect(MODEL_ROLE_CONFIGS.workhorse).toBeDefined();
    expect(MODEL_ROLE_CONFIGS.deep_context).toBeDefined();
    expect(MODEL_ROLE_CONFIGS.architect).toBeDefined();
    expect(MODEL_ROLE_CONFIGS.local).toBeDefined();
  });
});

// ============================================
// MODEL SELECTION — LOCAL ROUTING
// ============================================

describe("selectModel — local routing", () => {
  beforeEach(() => {
    registerApiKeys({
      deepseek: "sk-test-deepseek",
      anthropic: "sk-test-anthropic",
      gemini: "test-gemini-key",
      openai: "sk-test-openai",
    });
  });

  it("routes to local when offline", () => {
    const result = selectModel({ isOffline: true });
    expect(result.role).toBe("local");
    expect(result.provider).toBe("local");
    expect(result.model).toBe("qwen2.5-0.5b-instruct-q4_k_m");
  });

  it("routes to local with explicit 'local' role", () => {
    const result = selectModel({ explicitRole: "local" });
    expect(result.role).toBe("local");
    expect(result.provider).toBe("local");
  });

  it("workhorse fallback chain includes local as last resort", () => {
    // Remove all API keys — only local (no key needed) should be available
    registerApiKeys({
      deepseek: "",
      anthropic: "",
      gemini: "",
      openai: "",
    });
    const result = selectModel({});
    // Should fall through to local since no other provider has keys
    expect(result.provider).toBe("local");
  });
});

// ============================================
// CONNECTIVITY CHECK
// ============================================

describe("isCloudReachable", () => {
  it("returns a boolean", async () => {
    const result = await isCloudReachable();
    expect(typeof result).toBe("boolean");
  });
});

// ============================================
// LOCAL STATUS ACCESSORS
// ============================================

describe("getLocalStatus", () => {
  it("returns status object with expected shape", () => {
    const status = getLocalStatus();
    expect(typeof status.modelReady).toBe("boolean");
    expect(typeof status.modelName).toBe("string");
    expect(typeof status.modelsDir).toBe("string");
    expect(status.modelName).toContain("Qwen");
  });
});

describe("isLocalModelReady", () => {
  it("returns a boolean", () => {
    expect(typeof isLocalModelReady()).toBe("boolean");
  });
});
