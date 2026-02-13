# Tool Discovery & Creation Protocol

**THIS IS CRITICAL KNOWLEDGE FOR ALL AGENTS — READ CAREFULLY**

---

## You Are Not Limited By Your Initial Tool Set

Your initial tools are a **starting point**, not a constraint. If you need a tool you don't have, you have THREE powerful options:

---

## Option 1: Search for Existing Tools 🔍

**Use `tools.list_tools()` or `tools.search_tools(query: "...")` to discover tools you weren't initially given.**

### When to Search

- You need a specific capability but don't see it in your tools
- You're about to say "I can't do X" — search first!
- You want to check if there's a better tool for the job

### How to Search

```javascript
// List ALL available tools (browse the catalog)
tools.list_tools()

// Search for specific functionality
tools.search_tools({ query: "discord" })
tools.search_tools({ query: "image generation" })
tools.search_tools({ query: "pdf" })
tools.search_tools({ query: "database" })
```

### What You'll Find

The tool catalog includes:
- **Core tools**: Filesystem, shell, HTTP, search, etc.
- **Premium tools**: Google Search, Amazon, YouTube data, etc.
- **User-created tools**: Custom APIs and services the user added
- **Skills**: Saved workflows from previous agents
- **Platform-specific tools**: Client-side capabilities

**If you find the right tool, call `agent.request_tools(["tool.id"])` to add it to your toolset.**

---

## Option 2: Create Your Own Tool 🛠️

**If the right tool doesn't exist, CREATE IT using `tools.save_tool()`.**

This is a core capability — you can permanently add new tools to the system!

### When to Create a Tool

- You found a useful free API that should be reusable
- You need to interact with a service that requires specific formatting
- You've discovered a reliable data source worth saving
- You're doing a task that will likely be repeated

### How to Create a Tool

```javascript
// Test the API first!
http.request({
  url: "https://query1.finance.yahoo.com/v8/finance/chart/AAPL",
  headers: { "User-Agent": "Mozilla/5.0" }
})

// Once confirmed working, save it:
tools.save_tool({
  id: "finance.get_stock_price",
  name: "get_stock_price",
  description: "Get current stock price from Yahoo Finance free API",
  category: "premium",
  inputSchema: {
    type: "object",
    properties: {
      ticker: { type: "string", description: "Stock ticker symbol (e.g., AAPL, TSLA)" }
    },
    required: ["ticker"]
  },
  apiSpec: {
    method: "GET",
    url: "https://query1.finance.yahoo.com/v8/finance/chart/{ticker}",
    headers: { "User-Agent": "Mozilla/5.0" },
    responseExtract: "chart.result[0].meta.regularMarketPrice"
  }
})
```

### Tool Creation Rules

1. **Test it first** — Use `http.request()` to verify the API works before saving
2. **Document well** — Clear name and description for future agents
3. **Make it reusable** — Generic enough for similar tasks, specific enough to be useful
4. **Free APIs only** — Don't create tools for paid services without user confirmation
5. **No credentials** — Don't hardcode API keys (use the credential system instead)

### After Creation

- The tool is **immediately available** to you in the current session
- It's **permanently saved** for all future agents
- Other agents can discover it via `tools.search_tools()`

---

## Option 3: Escalate for Help 🚨

**Use `agent.escalate()` when you need human guidance or architectural decisions.**

### When to Escalate

- You need tools that require credentials you don't have
- The task requires destructive operations (delete, force-push, etc.)
- You're unsure which approach to take
- You found multiple tools and need the user to choose
- The task requires capabilities beyond any available tools

### How to Escalate

```javascript
agent.escalate({
  reason: "need_tools",
  details: "I need access to the Discord API to send messages, but I don't have discord.send_message or the required credentials.",
  suggestedAction: "Please configure Discord credentials or grant me access to discord.send_message tool."
})
```

---

## The Complete Flow

```
Task requires tool you don't have
    ↓
1. Search: tools.search_tools({ query: "what I need" })
    ↓
   Found it? → agent.request_tools(["tool.id"]) → Continue task
    ↓
   Not found?
    ↓
2. Check if you can create it
    ↓
   Free API? → Test it → tools.save_tool() → Continue task
    ↓
   Needs credentials/permissions?
    ↓
3. Escalate: agent.escalate() → Get help from user
```

---

## Examples of Success

### Example 1: Discovering an Existing Tool
```
Agent: I need to send a Discord message but don't have that tool
Agent: tools.search_tools({ query: "discord" })
Result: Found "discord.send_message"
Agent: agent.request_tools(["discord.send_message"])
Agent: ✅ Now I can complete the task
```

### Example 2: Creating a New Tool
```
Agent: User wants weather data. Let me check for a weather tool.
Agent: tools.search_tools({ query: "weather" })
Result: No weather tool exists
Agent: Let me test the free wttr.in API
Agent: http.request({ url: "https://wttr.in/Miami?format=j1" })
Result: Works! Returns clean JSON
Agent: tools.save_tool({ name: "get_weather", ... })
Agent: ✅ Tool created and available for all future weather requests
```

### Example 3: Escalating Appropriately
```
Agent: User wants to post to Twitter
Agent: tools.search_tools({ query: "twitter" })
Result: No Twitter tool found
Agent: Can't create this — needs OAuth credentials
Agent: agent.escalate({ reason: "need_credentials", details: "..." })
User: Configures Twitter credentials
Agent: ✅ Now has access and completes task
```

---

## Key Principles

1. **Never say "I don't have that tool" without searching first**
2. **If you tested an API and it works, save it as a tool**
3. **Tool creation is encouraged — you're expanding the system's capabilities**
4. **Escalate when you genuinely need help, not as a first resort**
5. **The tool catalog grows with every agent — contribute to it**

---

## Summary

**YOU HAVE THE POWER TO:**
- ✅ Discover hidden tools you weren't initially given
- ✅ Create new tools that will benefit all future agents
- ✅ Escalate when you need credentials, permissions, or guidance

**DON'T LET A MISSING TOOL STOP YOU. SEARCH, CREATE, OR ESCALATE.**
