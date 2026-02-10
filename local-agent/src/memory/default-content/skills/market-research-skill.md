---
name: market-research
description: Comprehensive market research combining Polymarket, Finnhub, Reddit, SEC EDGAR insider data, xAI sentiment, and Fear & Greed Index to identify potentially undervalued stocks and gauge market sentiment.
tags: [market, stocks, research, sentiment, polymarket, finnhub, reddit, insider, watchlist]
disable-model-invocation: false
user-invocable: true
allowed-tools: [market.polymarket_search, market.polymarket_event, market.stock_quote, market.stock_profile, market.xai_sentiment, market.reddit_buzz, market.fear_greed_index, market.insider_trades, knowledge.save, knowledge.read, knowledge.list, search.brave, http.request, secrets.prompt_user]
---

# Market Research Skill

## EXECUTION MODEL
This skill runs **autonomously**. Execute all tool calls yourself — do NOT stop between steps or ask the user for permission.

## Overview
Comprehensive market research combining multiple data sources to identify potentially undervalued stocks with rising social buzz, strong insider buying, and favorable macro conditions.

## Pre-Flight Checks

Before running the full analysis, verify tool availability:

1. **Finnhub API Key** — call `market.stock_quote({ symbol: "AAPL" })` as a test
   - If it fails with "not configured": call `secrets.prompt_user({ key_name: "FINNHUB_API_KEY", prompt: "Enter your Finnhub API key (free at https://finnhub.io/register)", allowed_domain: "finnhub.io" })`
   - Then retry the test call
2. **xAI API Key** (optional) — call `market.xai_sentiment({ topic: "test" })`
   - If it fails: inform user that X/Twitter sentiment analysis won't be available, but continue with other sources
   - Offer setup: `secrets.prompt_user({ key_name: "XAI_API_KEY", prompt: "Enter your xAI API key (get one at https://console.x.ai)", allowed_domain: "api.x.ai" })`

## Research Workflow

When the user asks for stock research, market analysis, or "find undervalued stocks":

### Step 1: Market Mood Baseline
```
market.fear_greed_index()
```
Note the current reading. Extreme Fear = better environment for contrarian picks.

### Step 2: Identify Candidates
If user specified stocks → use those. Otherwise, gather candidates from:
```
market.reddit_buzz({ query: "<sector or theme>", timeframe: "week", limit: 20 })
```
Look for stocks with high engagement (comments + upvotes) that aren't mega-caps.

### Step 3: For Each Candidate (top 3-5)

**3a. Fundamentals**
```
market.stock_quote({ symbol: "<TICKER>" })
market.stock_profile({ symbol: "<TICKER>" })
```
Check: Is it founder-led? What sector? Market cap size?

**3b. Insider Activity**
```
market.insider_trades({ symbol: "<TICKER>" })
```
Key signal: insider BUYS by CEO/CFO/founders. Sells are less meaningful (could be diversification).

**3c. Social Sentiment**
```
market.reddit_buzz({ query: "<TICKER>", timeframe: "week" })
```
If xAI is available:
```
market.xai_sentiment({ topic: "<TICKER>", context: "focus on retail investor sentiment and momentum signals" })
```

### Step 4: Macro Context (if relevant)
```
market.polymarket_search({ query: "<relevant macro event>" })
```
Check prediction market odds for events that could affect the sector.

### Step 5: Synthesize & Present

For each stock, present:
- **Company Overview**: Name, ticker, sector, CEO, founder-led status
- **Price Action**: Current price, change, context
- **Insider Signal**: Buy/sell ratio, notable transactions
- **Social Buzz**: Reddit engagement level, sentiment direction
- **X/Twitter Sentiment**: (if available) Grok's analysis
- **Divergence Score**: Rate 1-5 based on how many signals disagree with price
- **Bull/Bear Case**: Brief evidence-based cases for both sides

### Step 6: Save to Watchlist
```
knowledge.save({
  title: "Market Watchlist",
  content: JSON.stringify({
    lastUpdated: "<ISO date>",
    marketMood: "<Fear & Greed value>",
    picks: [
      {
        ticker: "<TICKER>",
        name: "<Company Name>",
        dateAdded: "<ISO date>",
        priceAtAdd: <price>,
        thesis: "<one-line thesis>",
        founderLed: true/false,
        insiderSignal: "bullish/bearish/neutral",
        socialBuzz: "high/medium/low",
        divergenceScore: <1-5>
      }
    ]
  }),
  description: "Active stock watchlist with research picks and thesis",
  tags: "stocks,watchlist,market-research,picks"
})
```

## Follow-Up Research

When the user asks to check on their watchlist:
1. `knowledge.read({ filename: "market-watchlist.json" })` — load existing picks
2. For each pick: refresh `stock_quote` and `reddit_buzz`
3. Compare current price vs. price at addition
4. Note any changes in thesis (insider activity changes, sentiment shifts)
5. Update the knowledge doc with fresh data

## Disclaimer
Always end research reports with:
> *This is research and analysis only — not financial advice. Always do your own due diligence before making investment decisions.*
