# Intake Knowledgebase — |* Agent ID *|
Generated: |* Timestamp *|

## 1. Relevant Memory Models (Summaries & Data Shapes)

These models were identified as directly relevant to this request. Summaries include structured data (beliefs, open loops, etc.) where available.

|* Relevant Model Summaries *|

|* Resurfaced Models Section *|

|* New Models Section *|

---
## 2. Possibly Related Memory Models

The following models *may* be related to this request but we are not certain. Review the data shapes below to decide if they are worth exploring further.

|* Related Models Summary *|

---
## 3. Local Files Found on This Machine

|* Local File Results *|

### How to Access Files

| Tool | Use for |
|------|---------|
| `search.files` | Find files by name/path across the entire machine (instant, NTFS-indexed). Supports wildcards (`*.pdf`), extensions (`ext:xlsx`), path filters (`path:projects`). |
| `filesystem.read_file` | Read the full contents of a text file (code, markdown, config, logs, etc.). |
| `filesystem.read_lines` | Read a specific line range from a large file — use this instead of `read_file` for files over a few hundred lines. Pass `start_line` and `end_line`. |
| `filesystem.file_info` | Check a file's size, type, and modification date before reading it. Use this to decide whether to read the full file or just a section. |

### Non-Text Files (PDFs, Images, Spreadsheets, Archives)

For binary/non-text files, use `knowledge.ingest` — it sends the file to Gemini (deep context LLM) which can process PDFs, images, video, audio, CSV, and compressed archives (.zip, .tar.gz).

**Important constraints:**
- **Size cap: 100 MB per file.** Check size with `filesystem.file_info` first.
- **Use ONLY if the file is critical** to accomplishing the task at hand. This tool uploads the file to an external LLM for processing — do not use it casually or for exploration.
- For archives: max 50 files per archive, 500 MB total extracted.

---
## 4. Knowledge Base Search Results

|* Knowledge Results *|

---
## 5. Web Research Results

|* Web Search Results *|

### How to Use Web Results

These results were gathered automatically from Brave Search based on the intake agent's approach steps. They provide titles, URLs, and descriptions only.

| Tool | Use for |
|------|---------|
| `http.render` | Read the full content of a web page — use this to get details from any URL listed above. |
| `search.brave` | Run additional web searches if the pre-fetched results are insufficient or you need a different angle. |

---
## 6. Prediction Markets (Polymarket)

|* Polymarket Results *|

### How to Interpret This Data

Polymarket prices represent **crowd-sourced probability estimates** — they reflect what traders with real money at stake believe about the likelihood of an event. Key points for interpretation:

- **Price = probability.** A "Yes" price of 0.72 means the market believes there is a ~72% chance of that outcome. These are not guarantees — they are the market's current best estimate.
- **Volume and liquidity matter.** High-volume markets (>$100K) with deep liquidity reflect broader consensus. Low-volume markets may be thinly traded and less reliable.
- **Markets can be wrong.** Prediction markets are historically well-calibrated in aggregate but can be biased by sentiment, manipulation, or information asymmetry on individual questions.
- **Relevance is contextual.** A prediction market about a regulation, election, or macro event may be directly relevant to a user's task — or it may be tangential. Evaluate whether the market's question actually maps to the user's concern.
- **Use for framing, not as ground truth.** Present market data as "the market currently estimates X at Y% probability" — not as fact. Always note the volume and end date for context.

### Drilling Deeper into Markets

| Tool | Use for |
|------|---------|
| `market.polymarket_search` | Run additional keyword searches if the pre-fetched results above are insufficient. Use short key phrases (2-4 words), not full sentences. |
| `market.polymarket_event` | Get detailed data for a specific market — historical price points, outcome descriptions, and resolution criteria. Pass the `slug` from search results. Use this to understand *how* a market resolves and whether its definition actually matches the user's question. |

### Sentiment & Crowd Knowledge

If this request involves gauging public opinion, market sentiment, or real-time reaction to events:

| Tool | Best for |
|------|----------|
| `market.xai_sentiment` | **Real-time sentiment on X/Twitter.** xAI's Grok model has live access to X social data — use it to get bullish/bearish signals, notable mentions, and trending narratives around a topic. Best for fast-moving events, product launches, policy announcements, and public figures. |
| `market.reddit_buzz` | **Deep crowd knowledge and retail sentiment.** Searches investing and discussion subreddits (wallstreetbets, stocks, investing, etc.) for recent posts. Reddit excels at surfacing grassroots opinions, contrarian takes, and niche community knowledge that doesn't appear in mainstream sources. Use when you need real-time crowd sentiment or want to understand how a community is reacting to news. |
| `search.brave` | **General web search** for news articles, blog posts, and official announcements that provide factual context alongside sentiment data. |

**Strategy:** Combine these for a complete picture — Polymarket for probability estimates, xAI/Grok for real-time social pulse, Reddit for deep crowd discussion, and web search for factual grounding.

---
## 7. Research Output Protocol

All paths below refer to **your agent's isolated workspace** at `~/.bot/agent-workspaces/[agent-id]/`. This workspace persists for **24 hours after task completion**.

### Required Outputs for Research Tasks

1. **Research Notes → `workspace/research/[descriptive-name]-[YYYY-MM-DD].md`**
   - All data sources with URLs, raw findings and quotes, analysis methodology
   - Tool calls made and results, edge cases and limitations discovered
   - Structured for future agents to pick up where you left off

2. **Executive Summary → `workspace/output/report.md`**
   - Key findings (3-5 bullet points), recommendations, charts/tables
   - Clear, non-technical language for the user

3. **Tool Call Log → `workspace/logs/tool-calls.jsonl`** — Automatically created by the system.

### When to Save to Knowledge vs Workspace

**Use `knowledge.save()` ONLY when:** user explicitly says to remember something, creating a persistent watchlist/tracking doc, storing user preferences.

**Use workspace files for:** general research findings, temporary analysis, exploratory work.

### CRITICAL: Check for Previous Research First

**BEFORE starting any research, ALWAYS call tool `research.list` to check if previous work exists:**
```javascript
research.list({ workspace: "~/.bot/agent-workspaces/[agent-id]" })
```
If previous research exists, read it with `filesystem.read_file` and build on it instead of starting from scratch.

### Long Tasks (Regrouping)

If you exceed 15+ tool calls: save progress to `workspace/research/progress-checkpoint.md` with what you've learned, what you still need, and next steps.

### Saving Research

Use `research.save` to create both research notes and executive summary:
```javascript
research.save({
  workspace: "~/.bot/agent-workspaces/[agent-id]",
  title: "Short descriptive title",
  type: "market-analysis",  // market-analysis | news-summary | general-research | competitive-analysis | technical-research
  detailed_notes: "# Full markdown research notes — sources, methodology, findings, raw data...",
  executive_summary: "Brief 2-3 paragraph summary with key takeaways and recommendations.",
  tags: ["relevant", "tags"],
  metadata: { key: "value" }
})
```
This automatically creates `workspace/research/[slug]-[date].md` and `workspace/output/report.md` with proper frontmatter.

---
## 8. Tool Discovery & Creation Protocol

**You are NOT limited by your initial tool set.** If you need a tool you don't have, you have three options:

### Option 1: Search for Existing Tools

Use `tools.list_tools()` or `tools.search_tools({ query: "..." })` to discover tools you weren't initially given.

**When to search:**
- You need a specific capability but don't see it in your tools
- You're about to say "I can't do X" — **search first!**
- You want to check if there's a better tool for the job

If you find the right tool, call `agent.request_tools(["tool.id"])` to add it to your toolset.

### Option 2: Create Your Own Tool

If the right tool doesn't exist, **create it** using `tools.save_tool()`.

**When to create:**
- You found a useful free API that should be reusable
- You need to interact with a service that requires specific formatting
- You're doing a task that will likely be repeated

**Rules:** Test with `http.request()` first, document well, make it reusable, free APIs only, no hardcoded credentials.

```javascript
tools.save_tool({
  id: "category.tool_name",
  name: "tool_name",
  description: "Clear description for future agents",
  category: "premium",
  inputSchema: { type: "object", properties: { ... }, required: [...] },
  apiSpec: { baseUrl: "https://api.example.com", method: "GET", path: "/endpoint/{param}", headers: { "User-Agent": "DotBot" } }
})
```

### Option 3: Escalate for Help

Use `agent.escalate()` when you need credentials, permissions, or architectural decisions you can't make alone.

### The Flow

```
Need a tool you don't have?
  → Search: tools.search_tools({ query: "what I need" })
    → Found? → agent.request_tools(["tool.id"]) → Continue
    → Not found? → Can create? → Test → tools.save_tool() → Continue
    → Needs credentials? → agent.escalate() → Get help
```

**NEVER say "I don't have that tool" without searching first. Tool creation is encouraged — you're expanding the system's capabilities.**
