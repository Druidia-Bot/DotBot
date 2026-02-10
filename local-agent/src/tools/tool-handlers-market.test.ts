/**
 * Market Research Tool Handler Tests
 * 
 * Tests the handleMarket dispatcher and each individual handler:
 * - Polymarket search/event (mock fetch)
 * - Finnhub stock quote/profile/insider trades (mock credentialProxyFetch + vaultHas)
 * - Reddit buzz (mock fetch)
 * - Fear & Greed Index (mock fetch)
 * - xAI sentiment (mock serverLLMCall)
 * - Input validation, error handling, output truncation
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock credential-vault before importing handler
vi.mock("../credential-vault.js", () => ({
  vaultHas: vi.fn(),
}));

// Mock credential-proxy before importing handler
vi.mock("../credential-proxy.js", () => ({
  credentialProxyFetch: vi.fn(),
}));

// Mock server-llm before importing handler
vi.mock("../server-llm.js", () => ({
  serverLLMCall: vi.fn(),
}));

import { handleMarket } from "./tool-handlers-market.js";
import { vaultHas } from "../credential-vault.js";
import { credentialProxyFetch } from "../credential-proxy.js";
import { serverLLMCall } from "../server-llm.js";

const mockVaultHas = vi.mocked(vaultHas);
const mockProxyFetch = vi.mocked(credentialProxyFetch);
const mockServerLLMCall = vi.mocked(serverLLMCall);

beforeEach(() => {
  vi.restoreAllMocks();
  mockVaultHas.mockResolvedValue(false);
});

// ============================================
// DISPATCHER
// ============================================

describe("handleMarket — dispatcher", () => {
  it("returns error for unknown tool ID", async () => {
    const result = await handleMarket("market.nonexistent", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown market tool");
  });

  it("routes to correct handler for each tool ID", async () => {
    // polymarket_search requires query
    const r1 = await handleMarket("market.polymarket_search", {});
    expect(r1.error).toBe("query is required");

    // polymarket_event requires slug or condition_id
    const r2 = await handleMarket("market.polymarket_event", {});
    expect(r2.error).toContain("Either slug or condition_id is required");

    // stock_quote requires symbol (and vault check)
    const r3 = await handleMarket("market.stock_quote", {});
    expect(r3.error).toBe("symbol is required");

    // reddit_buzz requires query
    const r4 = await handleMarket("market.reddit_buzz", {});
    expect(r4.error).toBe("query is required");

    // xai_sentiment requires topic
    const r5 = await handleMarket("market.xai_sentiment", {});
    expect(r5.error).toBe("topic is required");
  });
});

// ============================================
// POLYMARKET SEARCH
// ============================================

describe("handleMarket — polymarket_search", () => {
  it("requires query parameter", async () => {
    const result = await handleMarket("market.polymarket_search", {});
    expect(result.success).toBe(false);
    expect(result.error).toBe("query is required");
  });

  it("returns results on success", async () => {
    const mockMarkets = [
      { question: "Will BTC hit 100k?", slug: "btc-100k", volume: "5000000", liquidity: "200000", active: true },
      { question: "Fed rate cut?", slug: "fed-rate", volume: "3000000", liquidity: "100000", active: true },
    ];

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockMarkets),
    } as any);

    const result = await handleMarket("market.polymarket_search", { query: "bitcoin" });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].question).toBe("Will BTC hit 100k?");
    expect(parsed[0].slug).toBe("btc-100k");
  });

  it("returns empty message when no markets found", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    } as any);

    const result = await handleMarket("market.polymarket_search", { query: "zzzzz" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("No Polymarket events found");
  });

  it("handles non-array response gracefully", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ error: "unexpected" }),
    } as any);

    const result = await handleMarket("market.polymarket_search", { query: "test" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("No Polymarket events found");
  });

  it("handles API error response", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    } as any);

    const result = await handleMarket("market.polymarket_search", { query: "test" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("500");
  });

  it("handles network error", async () => {
    global.fetch = vi.fn().mockRejectedValueOnce(new Error("network timeout"));

    const result = await handleMarket("market.polymarket_search", { query: "test" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("network timeout");
  });

  it("truncates large output", async () => {
    const bigMarkets = Array.from({ length: 50 }, (_, i) => ({
      question: `Market question ${i} ${"x".repeat(200)}`,
      slug: `slug-${i}`,
      volume: "1000000",
      liquidity: "50000",
      active: true,
    }));

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(bigMarkets),
    } as any);

    const result = await handleMarket("market.polymarket_search", { query: "test", limit: 50 });
    expect(result.success).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(8020); // 8000 + "[truncated]" suffix
  });

  it("clamps limit to 50", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    } as any);

    await handleMarket("market.polymarket_search", { query: "test", limit: 999 });
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain("limit=50");
  });
});

// ============================================
// POLYMARKET EVENT
// ============================================

describe("handleMarket — polymarket_event", () => {
  it("requires slug or condition_id", async () => {
    const result = await handleMarket("market.polymarket_event", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("Either slug or condition_id");
  });

  it("returns market detail by slug", async () => {
    const mockMarket = { question: "Will BTC hit 100k?", slug: "btc-100k", volume: "5000000", outcomes: ["Yes", "No"] };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([mockMarket]),
    } as any);

    const result = await handleMarket("market.polymarket_event", { slug: "btc-100k" });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.question).toBe("Will BTC hit 100k?");
    expect(parsed.outcomes).toEqual(["Yes", "No"]);
  });

  it("returns not found message when market missing", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    } as any);

    const result = await handleMarket("market.polymarket_event", { slug: "nonexistent" });
    expect(result.success).toBe(true);
    expect(result.output).toBe("Market not found.");
  });
});

// ============================================
// FINNHUB — stock_quote
// ============================================

describe("handleMarket — stock_quote", () => {
  it("requires symbol parameter", async () => {
    const result = await handleMarket("market.stock_quote", {});
    expect(result.success).toBe(false);
    expect(result.error).toBe("symbol is required");
  });

  it("returns setup instructions when Finnhub key not in vault", async () => {
    mockVaultHas.mockResolvedValue(false);
    const result = await handleMarket("market.stock_quote", { symbol: "AAPL" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Finnhub API key not configured");
    expect(result.error).toContain("secrets.prompt_user");
  });

  it("returns formatted quote on success", async () => {
    mockVaultHas.mockResolvedValue(true);
    mockProxyFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: {},
      body: JSON.stringify({ c: 150.25, d: 2.5, dp: 1.69, h: 152, l: 148, o: 149, pc: 147.75, t: 1707580800 }),
    });

    const result = await handleMarket("market.stock_quote", { symbol: "aapl" });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.symbol).toBe("AAPL"); // uppercased
    expect(parsed.currentPrice).toBe(150.25);
    expect(parsed.changePercent).toBe("1.69%");
  });

  it("returns not found for empty quote", async () => {
    mockVaultHas.mockResolvedValue(true);
    mockProxyFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: {},
      body: JSON.stringify({ c: null, d: null, dp: null, h: null, l: null, o: null, pc: null }),
    });

    const result = await handleMarket("market.stock_quote", { symbol: "FAKE" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("No quote data found");
  });

  it("handles Finnhub 403 (invalid key)", async () => {
    mockVaultHas.mockResolvedValue(true);
    mockProxyFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      headers: {},
      body: "Access denied",
    });

    const result = await handleMarket("market.stock_quote", { symbol: "AAPL" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("403");
  });
});

// ============================================
// FINNHUB — stock_profile
// ============================================

describe("handleMarket — stock_profile", () => {
  it("returns formatted profile on success", async () => {
    mockVaultHas.mockResolvedValue(true);
    mockProxyFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: {},
      body: JSON.stringify({
        ticker: "AAPL",
        name: "Apple Inc",
        country: "US",
        currency: "USD",
        exchange: "NASDAQ",
        ipo: "1980-12-12",
        marketCapitalization: 2500000,
        shareOutstanding: 15400,
        finnhubIndustry: "Technology",
        logo: "https://example.com/logo.png",
        weburl: "https://apple.com",
      }),
    });

    const result = await handleMarket("market.stock_profile", { symbol: "AAPL" });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.name).toBe("Apple Inc");
    expect(parsed.industry).toBe("Technology");
  });

  it("returns not found for unknown symbol", async () => {
    mockVaultHas.mockResolvedValue(true);
    mockProxyFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: {},
      body: JSON.stringify({}),
    });

    const result = await handleMarket("market.stock_profile", { symbol: "ZZZZZ" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("No profile found");
  });
});

// ============================================
// FINNHUB — insider_trades
// ============================================

describe("handleMarket — insider_trades", () => {
  it("returns buy/sell summary on success", async () => {
    mockVaultHas.mockResolvedValue(true);
    mockProxyFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: {},
      body: JSON.stringify({
        data: [
          { name: "Tim Cook", transactionType: "CEO", change: 50000, transactionCode: "P", filingDate: "2026-01-15", transactionDate: "2026-01-14", share: 50000, transactionPrice: 150 },
          { name: "Luca Maestri", transactionType: "CFO", change: -10000, transactionCode: "S", filingDate: "2026-01-10", transactionDate: "2026-01-09", share: 10000, transactionPrice: 155 },
        ],
      }),
    });

    const result = await handleMarket("market.insider_trades", { symbol: "AAPL" });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.buys).toBe(1);
    expect(parsed.sells).toBe(1);
    expect(parsed.totalTransactions).toBe(2);
    expect(parsed.symbol).toBe("AAPL");
  });

  it("uses strict transactionCode for buy/sell classification", async () => {
    mockVaultHas.mockResolvedValue(true);
    // A grant (code "A") with positive change should NOT be counted as buy
    mockProxyFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: {},
      body: JSON.stringify({
        data: [
          { name: "Test", transactionType: "Dir", change: 1000, transactionCode: "A", filingDate: "2026-01-15", transactionDate: "2026-01-14", share: 1000, transactionPrice: 0 },
        ],
      }),
    });

    const result = await handleMarket("market.insider_trades", { symbol: "TEST" });
    const parsed = JSON.parse(result.output);
    expect(parsed.buys).toBe(0); // grant, not a buy
    expect(parsed.sells).toBe(0);
    expect(parsed.totalTransactions).toBe(1);
  });

  it("returns no transactions message when empty", async () => {
    mockVaultHas.mockResolvedValue(true);
    mockProxyFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: {},
      body: JSON.stringify({ data: [] }),
    });

    const result = await handleMarket("market.insider_trades", { symbol: "AAPL" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("No insider transactions found");
  });
});

// ============================================
// REDDIT BUZZ
// ============================================

describe("handleMarket — reddit_buzz", () => {
  it("requires query parameter", async () => {
    const result = await handleMarket("market.reddit_buzz", {});
    expect(result.success).toBe(false);
    expect(result.error).toBe("query is required");
  });

  it("returns posts on success", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        data: {
          children: [
            { data: { title: "NVDA to the moon", subreddit: "wallstreetbets", score: 500, num_comments: 200, upvote_ratio: 0.95, created_utc: 1707580800, permalink: "/r/wsb/1", selftext: "" } },
            { data: { title: "NVDA earnings analysis", subreddit: "stocks", score: 300, num_comments: 80, upvote_ratio: 0.90, created_utc: 1707494400, permalink: "/r/stocks/2", selftext: "Great quarter" } },
          ],
        },
      }),
    } as any);

    const result = await handleMarket("market.reddit_buzz", { query: "NVDA" });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.postsFound).toBe(2);
    expect(parsed.totalEngagement.upvotes).toBe(800);
    expect(parsed.totalEngagement.comments).toBe(280);
    expect(parsed.posts[0].title).toBe("NVDA to the moon");
  });

  it("defaults to 'week' for invalid timeframe", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { children: [] } }),
    } as any);

    await handleMarket("market.reddit_buzz", { query: "test", timeframe: "INVALID" });
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain("t=week");
  });

  it("uses valid timeframe when provided", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { children: [] } }),
    } as any);

    await handleMarket("market.reddit_buzz", { query: "test", timeframe: "month" });
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain("t=month");
  });

  it("handles 429 rate limit", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 429,
    } as any);

    const result = await handleMarket("market.reddit_buzz", { query: "test" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("rate limited");
  });
});

// ============================================
// FEAR & GREED
// ============================================

describe("handleMarket — fear_greed", () => {
  it("returns current and previous values", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        data: [
          { value: "35", value_classification: "Fear", timestamp: "1707580800" },
          { value: "40", value_classification: "Fear", timestamp: "1707494400" },
        ],
      }),
    } as any);

    const result = await handleMarket("market.fear_greed_index", {});
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.value).toBe(35);
    expect(parsed.classification).toBe("Fear");
    expect(parsed.previousValue).toBe(40);
  });

  it("handles NaN values gracefully", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        data: [
          { value: "not-a-number", value_classification: "", timestamp: "bad" },
        ],
      }),
    } as any);

    const result = await handleMarket("market.fear_greed_index", {});
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.value).toBeNull();
    expect(parsed.classification).toBe("Unknown");
    // timestamp should fallback to current time (not throw)
    expect(parsed.timestamp).toBeTruthy();
  });

  it("handles empty data", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    } as any);

    const result = await handleMarket("market.fear_greed_index", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("No Fear & Greed data available");
  });

  it("handles API error", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 503,
    } as any);

    const result = await handleMarket("market.fear_greed_index", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("503");
  });
});

// ============================================
// XAI SENTIMENT
// ============================================

describe("handleMarket — xai_sentiment", () => {
  it("requires topic parameter", async () => {
    const result = await handleMarket("market.xai_sentiment", {});
    expect(result.success).toBe(false);
    expect(result.error).toBe("topic is required");
  });

  it("returns sentiment analysis on success", async () => {
    mockServerLLMCall.mockResolvedValueOnce({
      success: true,
      content: "**Overall Sentiment**: Bullish (7/10)\n\nNVDA showing strong momentum...",
      model: "grok-4-1-fast-reasoning",
      provider: "xai",
    });

    const result = await handleMarket("market.xai_sentiment", { topic: "NVDA" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Bullish");
  });

  it("sends correct provider, model and context", async () => {
    mockServerLLMCall.mockResolvedValueOnce({
      success: true,
      content: "Analysis...",
    });

    await handleMarket("market.xai_sentiment", { topic: "AAPL", context: "focus on earnings" });

    expect(mockServerLLMCall).toHaveBeenCalledOnce();
    const callArgs = mockServerLLMCall.mock.calls[0][0];
    expect(callArgs.provider).toBe("xai");
    expect(callArgs.model).toBe("grok-4-1-fast-reasoning");
    expect(callArgs.messages[1].content).toContain("AAPL");
    expect(callArgs.messages[1].content).toContain("focus on earnings");
  });

  it("handles empty xAI response", async () => {
    mockServerLLMCall.mockResolvedValueOnce({
      success: true,
      content: "",
    });

    const result = await handleMarket("market.xai_sentiment", { topic: "NVDA" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("empty response");
  });

  it("handles server LLM error", async () => {
    mockServerLLMCall.mockResolvedValueOnce({
      success: false,
      error: 'No API key configured for provider "xai"',
    });

    const result = await handleMarket("market.xai_sentiment", { topic: "NVDA" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("xai");
  });

  it("handles network failure", async () => {
    mockServerLLMCall.mockRejectedValueOnce(new Error("Server LLM call timed out"));

    const result = await handleMarket("market.xai_sentiment", { topic: "NVDA" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
  });
});
