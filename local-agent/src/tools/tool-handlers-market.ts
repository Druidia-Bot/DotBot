/**
 * Market Research Tool Handlers
 * 
 * Implements: Polymarket search/event, Finnhub stock quote/profile/insider trades,
 * Reddit buzz, Fear & Greed Index, xAI sentiment (via credential proxy).
 */

import { credentialProxyFetch } from "../credential-proxy.js";
import { vaultHas } from "../credential-vault.js";

const FINNHUB_BASE = "https://finnhub.io/api/v1";
const FINNHUB_CREDENTIAL_NAME = "FINNHUB_API_KEY";

const POLYMARKET_GAMMA_BASE = "https://gamma-api.polymarket.com";

// ============================================
// MAIN DISPATCHER
// ============================================

export async function handleMarket(
  toolId: string,
  args: Record<string, any>
): Promise<{ success: boolean; output: string; error?: string }> {
  switch (toolId) {
    case "market.polymarket_search":
      return polymarketSearch(args);
    case "market.polymarket_event":
      return polymarketEvent(args);
    case "market.stock_quote":
      return stockQuote(args);
    case "market.stock_profile":
      return stockProfile(args);
    case "market.reddit_buzz":
      return redditBuzz(args);
    case "market.fear_greed_index":
      return fearGreed();
    case "market.insider_trades":
      return insiderTrades(args);
    case "market.xai_sentiment":
      return xaiSentiment(args);
    default:
      return { success: false, output: "", error: `Unknown market tool: ${toolId}` };
  }
}

// ============================================
// POLYMARKET
// ============================================

async function polymarketSearch(args: Record<string, any>): Promise<{ success: boolean; output: string; error?: string }> {
  const query = args.query as string;
  if (!query) return { success: false, output: "", error: "query is required" };
  const limit = Math.min(args.limit || 10, 50);

  try {
    const url = `${POLYMARKET_GAMMA_BASE}/markets?closed=false&limit=${limit}&search=${encodeURIComponent(query)}`;
    const resp = await fetch(url, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "(no body)");
      return { success: false, output: "", error: `Polymarket API returned ${resp.status}: ${errText.substring(0, 500)}` };
    }

    const raw = await resp.json();
    const markets = Array.isArray(raw) ? raw : [];
    if (!markets.length) {
      return { success: true, output: `No Polymarket events found for "${query}".` };
    }

    const results = markets.map((m: any) => ({
      question: m.question || m.title,
      slug: m.slug,
      conditionId: m.conditionId || m.condition_id,
      outcomePrices: m.outcomePrices || m.outcome_prices,
      volume: m.volume ? `$${Number(m.volume).toLocaleString()}` : "N/A",
      liquidity: m.liquidity ? `$${Number(m.liquidity).toLocaleString()}` : "N/A",
      endDate: m.endDate || m.end_date_iso,
      active: m.active ?? true,
    }));

    const output = JSON.stringify(results, null, 2);
    return { success: true, output: output.length > 8000 ? output.substring(0, 8000) + "\n...[truncated]" : output };
  } catch (err) {
    return { success: false, output: "", error: `Polymarket search failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function polymarketEvent(args: Record<string, any>): Promise<{ success: boolean; output: string; error?: string }> {
  const slug = args.slug as string;
  const conditionId = args.condition_id as string;

  if (!slug && !conditionId) {
    return { success: false, output: "", error: "Either slug or condition_id is required" };
  }

  try {
    let url: string;
    if (slug) {
      url = `${POLYMARKET_GAMMA_BASE}/markets?slug=${encodeURIComponent(slug)}`;
    } else {
      url = `${POLYMARKET_GAMMA_BASE}/markets?condition_id=${encodeURIComponent(conditionId)}`;
    }

    const resp = await fetch(url, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "(no body)");
      return { success: false, output: "", error: `Polymarket API returned ${resp.status}: ${errText.substring(0, 500)}` };
    }

    const data = await resp.json();
    const market = Array.isArray(data) ? data[0] : data;
    if (!market) {
      return { success: true, output: "Market not found." };
    }

    const detail: Record<string, any> = {
      question: market.question || market.title,
      slug: market.slug,
      conditionId: market.conditionId || market.condition_id,
      outcomePrices: market.outcomePrices || market.outcome_prices,
      outcomes: market.outcomes,
      volume: market.volume ? `$${Number(market.volume).toLocaleString()}` : "N/A",
      liquidity: market.liquidity ? `$${Number(market.liquidity).toLocaleString()}` : "N/A",
      startDate: market.startDate || market.start_date_iso,
      endDate: market.endDate || market.end_date_iso,
      description: market.description?.substring(0, 500),
      active: market.active ?? true,
    };

    return { success: true, output: JSON.stringify(detail, null, 2) };
  } catch (err) {
    return { success: false, output: "", error: `Polymarket event lookup failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ============================================
// FINNHUB (stock data)
// ============================================

async function finnhubFetch(path: string): Promise<{ success: boolean; output: string; error?: string }> {
  const hasKey = await vaultHas(FINNHUB_CREDENTIAL_NAME);
  if (!hasKey) {
    return {
      success: false,
      output: "",
      error: `Finnhub API key not configured. To set it up:\n1. Get a free API key at https://finnhub.io/register (60 calls/min free)\n2. Run: secrets.prompt_user({ key_name: "FINNHUB_API_KEY", prompt: "Enter your Finnhub API key", allowed_domain: "finnhub.io" })`,
    };
  }

  try {
    const result = await credentialProxyFetch(path, FINNHUB_CREDENTIAL_NAME, {
      baseUrl: FINNHUB_BASE,
      method: "GET",
      headers: { "Accept": "application/json" },
      placement: { header: "X-Finnhub-Token", prefix: "" },
    });

    if (result.status >= 400) {
      return { success: false, output: "", error: `Finnhub returned ${result.status}: ${result.body.substring(0, 500)}` };
    }

    return { success: true, output: result.body.substring(0, 8000) };
  } catch (err) {
    return { success: false, output: "", error: `Finnhub request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function stockQuote(args: Record<string, any>): Promise<{ success: boolean; output: string; error?: string }> {
  const symbol = (args.symbol as string)?.toUpperCase();
  if (!symbol) return { success: false, output: "", error: "symbol is required" };

  const result = await finnhubFetch(`/quote?symbol=${encodeURIComponent(symbol)}`);
  if (!result.success) return result;

  try {
    const data = JSON.parse(result.output);
    if (!data.c && data.c !== 0) {
      return { success: true, output: `No quote data found for ${symbol}. Verify the ticker symbol is correct.` };
    }

    const quote = {
      symbol,
      currentPrice: data.c,
      change: data.d,
      changePercent: data.dp ? `${data.dp.toFixed(2)}%` : "N/A",
      high: data.h,
      low: data.l,
      open: data.o,
      previousClose: data.pc,
      timestamp: data.t ? new Date(data.t * 1000).toISOString() : "N/A",
    };

    return { success: true, output: JSON.stringify(quote, null, 2) };
  } catch {
    return result;
  }
}

async function stockProfile(args: Record<string, any>): Promise<{ success: boolean; output: string; error?: string }> {
  const symbol = (args.symbol as string)?.toUpperCase();
  if (!symbol) return { success: false, output: "", error: "symbol is required" };

  const result = await finnhubFetch(`/stock/profile2?symbol=${encodeURIComponent(symbol)}`);
  if (!result.success) return result;

  try {
    const data = JSON.parse(result.output);
    if (!data.name) {
      return { success: true, output: `No profile found for ${symbol}. Verify the ticker symbol is correct.` };
    }

    const profile = {
      symbol: data.ticker,
      name: data.name,
      country: data.country,
      currency: data.currency,
      exchange: data.exchange,
      ipo: data.ipo,
      marketCapitalization: data.marketCapitalization ? `$${(data.marketCapitalization).toLocaleString()}M` : "N/A",
      sharesOutstanding: data.shareOutstanding ? `${data.shareOutstanding.toLocaleString()}M` : "N/A",
      industry: data.finnhubIndustry,
      logo: data.logo,
      phone: data.phone,
      weburl: data.weburl,
    };

    return { success: true, output: JSON.stringify(profile, null, 2) };
  } catch {
    return result;
  }
}

async function insiderTrades(args: Record<string, any>): Promise<{ success: boolean; output: string; error?: string }> {
  const symbol = (args.symbol as string)?.toUpperCase();
  if (!symbol) return { success: false, output: "", error: "symbol is required" };

  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const fromDate = args.from_date || ninetyDaysAgo.toISOString().split("T")[0];
  const toDate = args.to_date || now.toISOString().split("T")[0];

  const result = await finnhubFetch(
    `/stock/insider-transactions?symbol=${encodeURIComponent(symbol)}&from=${fromDate}&to=${toDate}`
  );
  if (!result.success) return result;

  try {
    const data = JSON.parse(result.output);
    const transactions = (data.data || []).slice(0, 30).map((t: any) => ({
      name: t.name,
      title: t.transactionType,
      change: t.change,
      share: t.share,
      filingDate: t.filingDate,
      transactionDate: t.transactionDate,
      transactionCode: t.transactionCode,
      transactionPrice: t.transactionPrice,
    }));

    if (!transactions.length) {
      return { success: true, output: `No insider transactions found for ${symbol} between ${fromDate} and ${toDate}.` };
    }

    const buys = transactions.filter((t: any) => t.transactionCode === "P");
    const sells = transactions.filter((t: any) => t.transactionCode === "S");

    const summary = {
      symbol,
      period: `${fromDate} to ${toDate}`,
      totalTransactions: transactions.length,
      buys: buys.length,
      sells: sells.length,
      transactions: transactions,
    };

    return { success: true, output: JSON.stringify(summary, null, 2) };
  } catch {
    return result;
  }
}

// ============================================
// REDDIT BUZZ
// ============================================

async function redditBuzz(args: Record<string, any>): Promise<{ success: boolean; output: string; error?: string }> {
  const query = args.query as string;
  if (!query) return { success: false, output: "", error: "query is required" };
  const validTimeframes = ["day", "week", "month", "year"];
  const timeframe = validTimeframes.includes(args.timeframe) ? args.timeframe : "week";
  const limit = Math.min(args.limit || 15, 50);

  const subreddits = ["wallstreetbets", "stocks", "investing", "smallstreetbets", "pennystocks", "stockmarket", "options"];
  const subredditParam = subreddits.join("+");

  try {
    const url = `https://www.reddit.com/r/${subredditParam}/search.json?q=${encodeURIComponent(query)}&sort=relevance&t=${timeframe}&limit=${limit}&restrict_sr=on`;
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "DotBot/1.0 (Market Research)",
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      if (resp.status === 429) {
        return { success: false, output: "", error: "Reddit rate limited. Try again in a few seconds." };
      }
      return { success: false, output: "", error: `Reddit API returned ${resp.status}` };
    }

    const data = await resp.json() as any;
    const posts = (data?.data?.children || []).map((child: any) => {
      const p = child.data;
      return {
        title: p.title,
        subreddit: p.subreddit,
        score: p.score,
        comments: p.num_comments,
        upvoteRatio: p.upvote_ratio,
        created: new Date(p.created_utc * 1000).toISOString(),
        url: `https://reddit.com${p.permalink}`,
        selftext: p.selftext?.substring(0, 200) || "",
      };
    });

    if (!posts.length) {
      return { success: true, output: `No Reddit posts found for "${query}" in the last ${timeframe}.` };
    }

    const totalScore = posts.reduce((sum: number, p: any) => sum + (p.score || 0), 0);
    const totalComments = posts.reduce((sum: number, p: any) => sum + (p.comments || 0), 0);

    const result = {
      query,
      timeframe,
      postsFound: posts.length,
      totalEngagement: { upvotes: totalScore, comments: totalComments },
      posts,
    };

    const output = JSON.stringify(result, null, 2);
    return { success: true, output: output.length > 8000 ? output.substring(0, 8000) + "\n...[truncated]" : output };
  } catch (err) {
    return { success: false, output: "", error: `Reddit search failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ============================================
// XAI SENTIMENT (via credential proxy)
// ============================================

const XAI_BASE = "https://api.x.ai/v1";
const XAI_CREDENTIAL_NAME = "XAI_API_KEY";

async function xaiSentiment(args: Record<string, any>): Promise<{ success: boolean; output: string; error?: string }> {
  const topic = args.topic as string;
  if (!topic) return { success: false, output: "", error: "topic is required" };
  const context = args.context as string || "";

  const hasKey = await vaultHas(XAI_CREDENTIAL_NAME);
  if (!hasKey) {
    return {
      success: false,
      output: "",
      error: `xAI API key not configured. To set it up:\n1. Get an API key at https://console.x.ai/\n2. Run: secrets.prompt_user({ key_name: "XAI_API_KEY", prompt: "Enter your xAI API key", allowed_domain: "api.x.ai" })`,
    };
  }

  const systemPrompt = `You are a market sentiment analyst with access to real-time social media data from X (Twitter). Analyze the current sentiment around the given topic.

Provide a structured analysis:
1. **Overall Sentiment**: Bullish / Bearish / Neutral / Mixed (with confidence 1-10)
2. **Key Narratives**: What are people saying? What's driving the conversation?
3. **Notable Signals**: Any influential accounts, viral posts, or unusual activity?
4. **Momentum**: Is sentiment shifting? Getting stronger or weaker vs. last week?
5. **Contrarian Indicators**: Any signs the crowd might be wrong?

Be specific and data-oriented. If you're uncertain about real-time data, say so.`;

  const userPrompt = context
    ? `Analyze current sentiment for: ${topic}\n\nAdditional context: ${context}`
    : `Analyze current sentiment for: ${topic}`;

  const body = JSON.stringify({
    model: "grok-4-1-fast-reasoning",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 2048,
    temperature: 0.3,
  });

  try {
    const result = await credentialProxyFetch("/chat/completions", XAI_CREDENTIAL_NAME, {
      baseUrl: XAI_BASE,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      placement: { header: "Authorization", prefix: "Bearer " },
    });

    if (result.status >= 400) {
      return { success: false, output: "", error: `xAI API returned ${result.status}: ${result.body.substring(0, 500)}` };
    }

    let data: any;
    try {
      data = JSON.parse(result.body);
    } catch {
      return { success: false, output: "", error: `xAI returned unparseable response: ${result.body.substring(0, 200)}` };
    }
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      return { success: false, output: "", error: "xAI returned empty response" };
    }

    return { success: true, output: content };
  } catch (err) {
    return { success: false, output: "", error: `xAI sentiment analysis failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ============================================
// FEAR & GREED INDEX
// ============================================

async function fearGreed(): Promise<{ success: boolean; output: string; error?: string }> {
  try {
    const url = "https://api.alternative.me/fng/?limit=2";
    const resp = await fetch(url, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      return { success: false, output: "", error: `Fear & Greed API returned ${resp.status}` };
    }

    const data = await resp.json() as any;
    const entries = data?.data || [];
    if (!entries.length) {
      return { success: false, output: "", error: "No Fear & Greed data available" };
    }

    const current = entries[0];
    const previous = entries[1];

    const currentValue = parseInt(current.value, 10);
    const currentTs = parseInt(current.timestamp, 10);
    const previousValue = previous ? parseInt(previous.value, 10) : null;

    const result = {
      value: Number.isNaN(currentValue) ? null : currentValue,
      classification: current.value_classification || "Unknown",
      timestamp: Number.isNaN(currentTs) ? new Date().toISOString() : new Date(currentTs * 1000).toISOString(),
      previousValue: previousValue !== null && Number.isNaN(previousValue) ? null : previousValue,
      previousClassification: previous?.value_classification || null,
      note: "0 = Extreme Fear, 25 = Fear, 50 = Neutral, 75 = Greed, 100 = Extreme Greed. This is the crypto Fear & Greed Index from alternative.me — directionally similar to equity sentiment.",
    };

    return { success: true, output: JSON.stringify(result, null, 2) };
  } catch (err) {
    return { success: false, output: "", error: `Fear & Greed fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
