/**
 * ResilientLLMClient Tests — Runtime Provider Fallback
 * 
 * Covers:
 * - Retryable error detection (429, 500, 502, 503, 504, network errors)
 * - Non-retryable errors pass through unchanged
 * - Primary provider success — no fallback attempted
 * - Primary fails with 429 → falls back to next provider
 * - Primary fails → all fallbacks fail → original error thrown
 * - Fallback chain respects available API keys
 * - Stream fallback works the same way
 * - getRuntimeFallbacks excludes the failed provider
 */

import { describe, it, expect, vi } from "vitest";
import {
  ResilientLLMClient,
  isRetryableError,
  getRuntimeFallbacks,
} from "./resilient-client.js";
import type { ILLMClient, LLMMessage, LLMResponse, LLMStreamChunk } from "./types.js";

// ============================================
// HELPERS
// ============================================

function makeMockClient(
  provider: string,
  chatFn: () => Promise<LLMResponse>
): ILLMClient {
  return {
    provider: provider as any,
    chat: vi.fn(chatFn),
    stream: vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> {
      yield { content: "hello", done: false };
      yield { content: "", done: true };
    }),
  };
}

const OK_RESPONSE: LLMResponse = {
  content: "Hello!",
  model: "test-model",
  provider: "deepseek",
  usage: { inputTokens: 10, outputTokens: 5 },
};

const MESSAGES: LLMMessage[] = [
  { role: "user", content: "Hi" },
];

// ============================================
// isRetryableError
// ============================================

describe("isRetryableError", () => {
  it("detects 429 rate limit", () => {
    expect(isRetryableError(new Error("Gemini API error: 429 Rate limit exceeded"))).toBe(true);
  });

  it("detects 500 server error", () => {
    expect(isRetryableError(new Error("DeepSeek API error: 500 Internal Server Error"))).toBe(true);
  });

  it("detects 502 bad gateway", () => {
    expect(isRetryableError(new Error("Anthropic API error: 502"))).toBe(true);
  });

  it("detects 503 service unavailable", () => {
    expect(isRetryableError(new Error("503 Service Unavailable"))).toBe(true);
  });

  it("detects 504 gateway timeout", () => {
    expect(isRetryableError(new Error("504 Gateway Timeout"))).toBe(true);
  });

  it("detects 'rate limit' text", () => {
    expect(isRetryableError(new Error("rate limit exceeded for model"))).toBe(true);
  });

  it("detects 'too many requests'", () => {
    expect(isRetryableError(new Error("Too many requests, please try again later"))).toBe(true);
  });

  it("detects fetch failures", () => {
    expect(isRetryableError(new Error("fetch failed"))).toBe(true);
  });

  it("detects ECONNREFUSED", () => {
    expect(isRetryableError(new Error("connect ECONNREFUSED 127.0.0.1:8080"))).toBe(true);
  });

  it("detects ECONNRESET", () => {
    expect(isRetryableError(new Error("read ECONNRESET"))).toBe(true);
  });

  it("detects network errors", () => {
    expect(isRetryableError(new Error("network error"))).toBe(true);
  });

  it("detects timeouts", () => {
    expect(isRetryableError(new Error("request timed out"))).toBe(true);
  });

  it("does NOT flag 401 unauthorized", () => {
    expect(isRetryableError(new Error("Gemini API error: 401 Unauthorized"))).toBe(false);
  });

  it("does NOT flag 403 forbidden", () => {
    expect(isRetryableError(new Error("Anthropic API error: 403 Forbidden"))).toBe(false);
  });

  it("does NOT flag 400 bad request", () => {
    expect(isRetryableError(new Error("DeepSeek API error: 400 Bad Request"))).toBe(false);
  });

  it("does NOT flag generic errors", () => {
    expect(isRetryableError(new Error("Cannot read property 'foo' of undefined"))).toBe(false);
  });

  it("handles string errors", () => {
    expect(isRetryableError("429 rate limit")).toBe(true);
  });
});

// ============================================
// getRuntimeFallbacks
// ============================================

describe("getRuntimeFallbacks", () => {
  it("excludes the failed provider from the chain", () => {
    const fallbacks = getRuntimeFallbacks("workhorse", "deepseek");
    const providers = fallbacks.map(f => f.provider);
    expect(providers).not.toContain("deepseek");
    expect(providers.length).toBeGreaterThan(0);
  });

  it("returns full chain minus failed provider for workhorse", () => {
    const fallbacks = getRuntimeFallbacks("workhorse", "deepseek");
    expect(fallbacks.length).toBeGreaterThanOrEqual(3); // gemini, openai, anthropic, local
  });

  it("returns fallbacks for deep_context when gemini fails", () => {
    const fallbacks = getRuntimeFallbacks("deep_context", "gemini");
    const providers = fallbacks.map(f => f.provider);
    expect(providers).toContain("anthropic");
    expect(providers).toContain("deepseek");
    expect(providers).not.toContain("gemini");
  });

  it("returns fallbacks for architect when anthropic fails", () => {
    const fallbacks = getRuntimeFallbacks("architect", "anthropic");
    const providers = fallbacks.map(f => f.provider);
    expect(providers).toContain("deepseek");
    expect(providers).toContain("gemini");
    expect(providers).not.toContain("anthropic");
  });

  it("returns fallbacks for gui_fast when gemini fails", () => {
    const fallbacks = getRuntimeFallbacks("gui_fast", "gemini");
    const providers = fallbacks.map(f => f.provider);
    expect(providers).toContain("openai");
    expect(providers).toContain("deepseek");
    expect(providers).not.toContain("gemini");
  });

  it("each fallback has provider, model, temperature, maxTokens", () => {
    const fallbacks = getRuntimeFallbacks("workhorse", "deepseek");
    for (const f of fallbacks) {
      expect(f.provider).toBeTruthy();
      expect(f.model).toBeTruthy();
      expect(typeof f.temperature).toBe("number");
      expect(typeof f.maxTokens).toBe("number");
    }
  });
});

// ============================================
// ResilientLLMClient — chat()
// ============================================

describe("ResilientLLMClient chat()", () => {
  it("returns primary result on success — no fallback", async () => {
    const primary = makeMockClient("gemini", async () => OK_RESPONSE);

    const resilient = new ResilientLLMClient(
      primary,
      "deep_context",
      () => { throw new Error("should not be called"); },
      () => ""
    );

    const result = await resilient.chat(MESSAGES);
    expect(result).toBe(OK_RESPONSE);
    expect(primary.chat).toHaveBeenCalledTimes(1);
  });

  it("throws non-retryable errors without fallback", async () => {
    const primary = makeMockClient("gemini", async () => {
      throw new Error("Gemini API error: 401 Unauthorized");
    });

    const resilient = new ResilientLLMClient(
      primary,
      "deep_context",
      () => { throw new Error("should not be called"); },
      () => ""
    );

    await expect(resilient.chat(MESSAGES)).rejects.toThrow("401 Unauthorized");
  });

  it("falls back on 429 rate limit", async () => {
    const primary = makeMockClient("gemini", async () => {
      throw new Error("Gemini API error: 429 Rate limit exceeded");
    });

    const fallbackResponse: LLMResponse = {
      content: "Fallback response",
      model: "deepseek-chat",
      provider: "deepseek",
    };
    const fallbackClient = makeMockClient("deepseek", async () => fallbackResponse);

    const resilient = new ResilientLLMClient(
      primary,
      "deep_context",
      (provider) => {
        if (provider === "anthropic") return fallbackClient; // first in deep_context chain
        throw new Error("no key");
      },
      (provider) => provider === "anthropic" ? "sk-test" : ""
    );

    const result = await resilient.chat(MESSAGES);
    expect(result).toBe(fallbackResponse);
    expect(primary.chat).toHaveBeenCalledTimes(1);
    expect(fallbackClient.chat).toHaveBeenCalledTimes(1);
  });

  it("falls back on 500 server error", async () => {
    const primary = makeMockClient("deepseek", async () => {
      throw new Error("DeepSeek API error: 500 Internal Server Error");
    });

    const fallbackResponse: LLMResponse = {
      content: "From Gemini",
      model: "gemini-2.5-flash",
      provider: "gemini",
    };
    const fallbackClient = makeMockClient("gemini", async () => fallbackResponse);

    const resilient = new ResilientLLMClient(
      primary,
      "workhorse",
      (provider) => {
        // workhorse fallback chain: gemini → openai → anthropic → local
        if (provider === "gemini") return fallbackClient;
        throw new Error("no key");
      },
      (provider) => provider === "gemini" ? "test-key" : ""
    );

    const result = await resilient.chat(MESSAGES);
    expect(result.content).toBe("From Gemini");
  });

  it("falls back on network error (fetch failed)", async () => {
    const primary = makeMockClient("deepseek", async () => {
      throw new Error("fetch failed");
    });

    const fallbackResponse: LLMResponse = {
      content: "Network fallback",
      model: "gemini-2.5-flash",
      provider: "gemini",
    };
    const fallbackClient = makeMockClient("gemini", async () => fallbackResponse);

    const resilient = new ResilientLLMClient(
      primary,
      "workhorse",
      (provider) => {
        if (provider === "gemini") return fallbackClient;
        throw new Error("no key");
      },
      (provider) => provider === "gemini" ? "test-key" : ""
    );

    const result = await resilient.chat(MESSAGES);
    expect(result.content).toBe("Network fallback");
  });

  it("tries multiple fallbacks if first fallback also fails", async () => {
    const callOrder: string[] = [];

    const primary = makeMockClient("deepseek", async () => {
      callOrder.push("deepseek");
      throw new Error("DeepSeek API error: 429");
    });

    const failingFallback = makeMockClient("gemini", async () => {
      callOrder.push("gemini");
      throw new Error("Gemini API error: 503");
    });

    const successResponse: LLMResponse = {
      content: "Third time's a charm",
      model: "gpt-4o-mini",
      provider: "openai",
    };
    const successFallback = makeMockClient("openai", async () => successResponse);

    const resilient = new ResilientLLMClient(
      primary,
      "workhorse",
      (provider) => {
        if (provider === "gemini") return failingFallback;
        if (provider === "openai") return successFallback;
        throw new Error("no key");
      },
      (provider) => {
        if (provider === "gemini") return "gemini-key";
        if (provider === "openai") return "openai-key";
        return "";
      }
    );

    const result = await resilient.chat(MESSAGES);
    expect(result.content).toBe("Third time's a charm");
    expect(callOrder).toEqual(["deepseek", "gemini"]);
    expect(successFallback.chat).toHaveBeenCalledTimes(1);
  });

  it("throws original error when all fallbacks fail", async () => {
    const primary = makeMockClient("gemini", async () => {
      throw new Error("Gemini API error: 429 Rate limit");
    });

    const resilient = new ResilientLLMClient(
      primary,
      "deep_context",
      () => {
        throw new Error("all fallbacks fail");
      },
      () => "" // no keys available
    );

    await expect(resilient.chat(MESSAGES)).rejects.toThrow("Gemini API error: 429 Rate limit");
  });

  it("skips fallback providers without API keys", async () => {
    const primary = makeMockClient("deepseek", async () => {
      throw new Error("DeepSeek API error: 429");
    });

    const localResponse: LLMResponse = {
      content: "Local fallback",
      model: "qwen2.5-0.5b",
      provider: "local",
    };
    const localClient = makeMockClient("local", async () => localResponse);

    const resilient = new ResilientLLMClient(
      primary,
      "workhorse",
      (provider) => {
        if (provider === "local") return localClient;
        throw new Error("no key");
      },
      (provider) => {
        // Only local is "available" (doesn't need key)
        if (provider === "local") return "";
        return ""; // all other keys empty
      }
    );

    const result = await resilient.chat(MESSAGES);
    expect(result.content).toBe("Local fallback");
  });

  it("preserves caller's options in fallback call", async () => {
    const primary = makeMockClient("gemini", async () => {
      throw new Error("Gemini API error: 429");
    });

    let capturedOptions: any;
    const fallbackClient: ILLMClient = {
      provider: "deepseek" as any,
      chat: vi.fn(async (_msgs, opts) => {
        capturedOptions = opts;
        return OK_RESPONSE;
      }),
      stream: vi.fn(async function* () { yield { content: "", done: true }; }),
    };

    const resilient = new ResilientLLMClient(
      primary,
      "deep_context",
      (provider) => {
        if (provider === "anthropic") return fallbackClient;
        throw new Error("no key");
      },
      (provider) => provider === "anthropic" ? "sk-test" : ""
    );

    await resilient.chat(MESSAGES, {
      temperature: 0.9,
      maxTokens: 2048,
      responseFormat: "json_object",
    });

    // Caller's temperature and maxTokens should be preserved
    expect(capturedOptions.temperature).toBe(0.9);
    expect(capturedOptions.maxTokens).toBe(2048);
    expect(capturedOptions.responseFormat).toBe("json_object");
    // But model should be from the fallback chain
    expect(capturedOptions.model).toBeTruthy();
  });
});

// ============================================
// ResilientLLMClient — stream()
// ============================================

describe("ResilientLLMClient stream()", () => {
  it("returns primary stream on success", async () => {
    const primary: ILLMClient = {
      provider: "gemini" as any,
      chat: vi.fn(),
      stream: vi.fn(async function* () {
        yield { content: "chunk1", done: false };
        yield { content: "", done: true };
      }),
    };

    const resilient = new ResilientLLMClient(
      primary,
      "deep_context",
      () => { throw new Error("should not be called"); },
      () => ""
    );

    const chunks: string[] = [];
    for await (const chunk of resilient.stream(MESSAGES)) {
      chunks.push(chunk.content);
    }
    expect(chunks).toEqual(["chunk1", ""]);
  });

  it("falls back on stream error", async () => {
    const primary: ILLMClient = {
      provider: "gemini" as any,
      chat: vi.fn(),
      stream: vi.fn(async function* () {
        throw new Error("Gemini API error: 429");
      }),
    };

    const fallback: ILLMClient = {
      provider: "deepseek" as any,
      chat: vi.fn(),
      stream: vi.fn(async function* () {
        yield { content: "fallback-chunk", done: false };
        yield { content: "", done: true };
      }),
    };

    const resilient = new ResilientLLMClient(
      primary,
      "deep_context",
      (provider) => {
        if (provider === "anthropic") return fallback;
        throw new Error("no key");
      },
      (provider) => provider === "anthropic" ? "sk-test" : ""
    );

    const chunks: string[] = [];
    for await (const chunk of resilient.stream(MESSAGES)) {
      chunks.push(chunk.content);
    }
    expect(chunks).toEqual(["fallback-chunk", ""]);
  });

  it("throws non-retryable stream errors without fallback", async () => {
    const primary: ILLMClient = {
      provider: "gemini" as any,
      chat: vi.fn(),
      stream: vi.fn(async function* () {
        throw new Error("Gemini API error: 401 Unauthorized");
      }),
    };

    const resilient = new ResilientLLMClient(
      primary,
      "deep_context",
      () => { throw new Error("should not be called"); },
      () => ""
    );

    const chunks: string[] = [];
    await expect(async () => {
      for await (const chunk of resilient.stream(MESSAGES)) {
        chunks.push(chunk.content);
      }
    }).rejects.toThrow("401 Unauthorized");
  });
});

// ============================================
// PROVIDER FIELD
// ============================================

describe("ResilientLLMClient provider", () => {
  it("exposes primary provider as its own provider", () => {
    const primary = makeMockClient("gemini", async () => OK_RESPONSE);
    const resilient = new ResilientLLMClient(
      primary, "deep_context", () => primary, () => ""
    );
    expect(resilient.provider).toBe("gemini");
  });
});
