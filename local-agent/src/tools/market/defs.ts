/**
 * Market Research Tool Definitions
 */

import type { DotBotTool } from "../../memory/types.js";

export const marketTools: DotBotTool[] = [
  {
    id: "market.polymarket_search",
    name: "polymarket_search",
    description: "Search Polymarket prediction markets for events by keyword. Returns market titles, current prices (probability %), volume, and liquidity. Polymarket prices represent crowd-sourced probability estimates — useful for gauging public sentiment on macro events, regulation, elections, and sector-level outcomes. No API key required.",
    source: "core",
    category: "market",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (e.g., 'federal reserve', 'AI regulation', 'bitcoin')" },
        limit: { type: "number", description: "Max results to return (default: 10, max: 50)" },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "market.polymarket_event",
    name: "polymarket_event",
    description: "Get detailed data for a specific Polymarket event by its slug or condition ID. Returns current prices, historical price points, volume, end date, and outcome descriptions. Use after polymarket_search to drill into a specific market.",
    source: "core",
    category: "market",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Event slug from polymarket_search results (e.g., 'will-the-fed-cut-rates-in-march-2026')" },
        condition_id: { type: "string", description: "Alternative: condition ID from search results" },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "market.stock_quote",
    name: "stock_quote",
    description: "Get current stock quote data from Finnhub: price, change, change %, high, low, open, previous close, volume, and market cap. Requires a Finnhub API key (free tier: 60 calls/min). If not configured, returns setup instructions.",
    source: "core",
    category: "market",
    executor: "local",
    runtime: "internal",
    credentialRequired: "FINNHUB_API_KEY",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Stock ticker symbol (e.g., 'AAPL', 'TSLA', 'NVDA')" },
      },
      required: ["symbol"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "market.stock_profile",
    name: "stock_profile",
    description: "Get company profile from Finnhub: name, ticker, industry, sector, market cap, share outstanding, description, CEO, website, IPO date, exchange, and logo URL. Useful for understanding if a company is founder-led, what sector it operates in, and basic fundamentals.",
    source: "core",
    category: "market",
    executor: "local",
    runtime: "internal",
    credentialRequired: "FINNHUB_API_KEY",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Stock ticker symbol (e.g., 'AAPL', 'TSLA', 'NVDA')" },
      },
      required: ["symbol"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "market.xai_sentiment",
    name: "xai_sentiment",
    description: "Ask xAI's Grok model about real-time sentiment on X/Twitter for a topic, stock, or event. Grok has access to live social data from X, making it uniquely suited for real-time sentiment analysis. Returns a sentiment summary with bullish/bearish signals, notable mentions, and trending narratives. Uses the server's XAI_API_KEY.",
    source: "core",
    category: "market",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic, stock ticker, or event to analyze sentiment for (e.g., 'NVDA', 'AI stocks', 'Federal Reserve rate decision')" },
        context: { type: "string", description: "Optional additional context to focus the analysis (e.g., 'focus on retail investor sentiment', 'look for momentum signals')" },
      },
      required: ["topic"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "market.reddit_buzz",
    name: "reddit_buzz",
    description: "Search Reddit for recent discussions about a stock, topic, or company. Searches across investing subreddits (wallstreetbets, stocks, investing, smallstreetbets, pennystocks, etc.) and returns post titles, scores, comment counts, and subreddit sources. Useful for gauging retail investor attention and narrative momentum. No API key required.",
    source: "core",
    category: "market",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query — stock ticker, company name, or topic (e.g., 'PLTR', 'Palantir', 'AI defense stocks')" },
        timeframe: { type: "string", description: "Time filter: 'day', 'week', 'month', 'year' (default: 'week')" },
        limit: { type: "number", description: "Max results (default: 15, max: 50)" },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "market.fear_greed",
    name: "fear_greed_index",
    description: "Get the current CNN Fear & Greed Index value and classification. Returns a 0-100 score (0 = Extreme Fear, 100 = Extreme Greed) with the current classification and the previous close value. Useful as a market-wide sentiment baseline — positive stock divergence during Extreme Fear is a stronger signal than during Extreme Greed. No API key required.",
    source: "core",
    category: "market",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "market.insider_trades",
    name: "insider_trades",
    description: "Get recent SEC EDGAR insider trading data (Form 4 filings) for a stock. Returns insider names, titles (CEO, CFO, Director, etc.), transaction types (buy/sell), shares traded, price, and filing date. Insider BUYS are one of the strongest bullish signals — especially when founders or CEOs buy with their own money. Requires Finnhub API key.",
    source: "core",
    category: "market",
    executor: "local",
    runtime: "internal",
    credentialRequired: "FINNHUB_API_KEY",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Stock ticker symbol (e.g., 'AAPL', 'TSLA')" },
        from_date: { type: "string", description: "Start date for insider transactions (YYYY-MM-DD, default: 90 days ago)" },
        to_date: { type: "string", description: "End date (YYYY-MM-DD, default: today)" },
      },
      required: ["symbol"],
    },
    annotations: { readOnlyHint: true },
  },
];
