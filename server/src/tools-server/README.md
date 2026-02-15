# Server-Side Tools (`tools-server/`)

## What Makes a Tool "Server-Side"?

A server-side tool is one where **the server calls an external API directly using its own API keys**. The local agent never sees the credentials and never makes the HTTP request.

This is distinct from:

- **Local agent tools** — executed on the user's machine (filesystem, shell, browser, etc.)
- **Server-routed tools** — handled server-side but don't call external APIs (memory, knowledge, schedule)

## When to Create a Server-Side Tool

Create a tool here when **all** of these are true:

1. **The call requires an API key the user doesn't have** — the server owns the credential (e.g., ScrapingDog, Gemini image generation, OpenAI image generation)
2. **The response goes back to the LLM or workspace** — not directly to the user's filesystem
3. **The local agent can't do it** — either because of credential access or because the server needs to orchestrate the call (e.g., model selection, credit deduction)

## Current Tools

| Directory | Purpose | Provider Layer |
|-----------|---------|----------------|
| `imagegen/` | Image generation & editing | `IImageClient` in `llm/` (Gemini primary, OpenAI fallback) |
| `premium/` | Credit-gated data APIs (search, scraping, e-commerce, etc.) | `PremiumProvider` interface with pluggable providers |
| `schedule/` | Recurring task CRUD | None (writes to local SQLite) |

> **Note:** `schedule/` is here because its executor runs server-side (the scheduler engine lives on the server), even though it doesn't call external APIs. It's a server-side tool by execution context, not by credential usage.

## Directory Structure

```
tools-server/
  README.md

  imagegen/                         — Image generation tool
    types.ts                        — ImageGenResult, ExecuteCommandFn, ImageData
    manifest.ts                     — IMAGEGEN_TOOLS (tool definitions for LLM)
    executor.ts                     — Tool dispatcher + agent bridge I/O
    index.ts                        — Barrel exports
    (Provider logic lives in llm/gemini.ts and llm/openai-compatible.ts
     via IImageClient. No provider-specific code here.)

  premium/                          — Credit-gated premium APIs
    types.ts                        — PremiumToolResult, PremiumApiEntry, PremiumProvider interface
    manifest.ts                     — PREMIUM_TOOLS (tool definitions for LLM)
    executor.ts                     — Thin router: resolve provider → check credits → call → deduct
    list.ts                         — Aggregates catalogs from all providers, groups by category
    index.ts                        — Barrel exports
    providers/
      index.ts                      — PROVIDERS registry (add new providers here)
      scrapingdog/
        client.ts                   — ScrapingDogClient class (HTTP, auth, gzip)
        catalog.ts                  — Tool ID → ScrapingDog endpoint mapping (40+ APIs)
        index.ts                    — Implements PremiumProvider, exports singleton

  schedule/                         — Recurring task scheduling
    executor.ts                     — Schedule CRUD operations
    index.ts                        — Barrel exports
```

## How to Add a New Tool

### 1. New Image/Video Provider

Image and video generation use `IImageClient` / `IVideoClient` interfaces defined in `llm/types.ts`. The tool executor never knows which provider it's talking to.

To add a new image provider (e.g., Stability AI):

1. Implement `IImageClient` in a new class (e.g., `StabilityImageClient` in `llm/stability.ts`)
2. Add it to `IMAGE_CLIENT_FACTORIES` in `llm/providers.ts`
3. Add a fallback entry to `FALLBACK_CHAINS.image` in `llm/model-selector.ts`
4. Done — `createResilientImageClient()` picks it up automatically

```typescript
// llm/providers.ts
const IMAGE_CLIENT_FACTORIES: Partial<Record<LLMProvider, (apiKey: string) => IImageClient>> = {
  gemini: (apiKey) => new GeminiImageClient(apiKey),
  openai: (apiKey) => new OpenAIImageClient(apiKey),
  stability: (apiKey) => new StabilityImageClient(apiKey),  // ← add here
};
```

Video works the same way with `IVideoClient` and `VIDEO_CLIENT_FACTORIES`.

### 2. New Premium Provider

Premium tools are **user-facing concepts** (e.g., "web scraping", "search"). Providers are **swappable implementations** (e.g., ScrapingDog, Serper). The tool ID and manifest stay the same when you switch providers.

To add a new premium provider (e.g., Serper for search):

1. Create `premium/providers/serper/` with:
   - `client.ts` — HTTP client class
   - `catalog.ts` — `PremiumApiEntry[]` with tool IDs, categories, params
   - `index.ts` — Implements `PremiumProvider` interface
2. Register it in `premium/providers/index.ts`:

```typescript
import { serperProvider } from "./serper/index.js";

export const PROVIDERS: PremiumProvider[] = [
  scrapingDogProvider,
  serperProvider,  // ← add here
];
```

3. Done — the executor, list, and manifest all work automatically. If a tool ID is served by multiple providers, the first one in the array wins.

### 3. Entirely New Server-Side Tool

For a tool that doesn't fit into imagegen or premium:

1. Create a new subdirectory: `tools-server/<tool-name>/`
2. Add the standard files:
   - `types.ts` — Result type, any shared interfaces
   - `manifest.ts` — `ToolManifestEntry[]` (what the LLM sees)
   - `executor.ts` — Main entry point: `execute(toolId, args) → Result`
   - `index.ts` — Barrel exports
3. Wire it into the pipeline:
   - Add manifest import to `ws/context-builder.ts`, `planner/planner.ts`, `context/tools.ts`
   - Add executor to `ctx.state` in `planner/step-executor.ts`
   - Add category to `DYNAMIC_CATEGORIES` in `tool-loop/handlers/server-side-handlers.ts`

### Manifest vs. Universal Tools

Tools defined here with a `manifest.ts` are **manually appended** to the tool manifest in three places:

- `ws/context-builder.ts`
- `planner/planner.ts`
- `context/tools.ts`

This is because they're not part of the core tool registry that the local agent reports via `requestTools()`. If your new tool needs to appear in the LLM's tool list, add its manifest import to those three files.

Tools that are part of `tools/definitions/universal.ts` (like schedule, memory, knowledge) are automatically included via the core registry — they don't need manual manifest injection.

## Model Selection & Fallback

Tools that call LLM provider APIs should use the client interfaces rather than making raw HTTP calls:

```typescript
// Image generation — uses IImageClient with automatic fallback
import { createResilientImageClient } from "#llm/providers.js";
const client = createResilientImageClient();
const result = await client.generate({ prompt: "a cat", aspectRatio: "16:9" });

// Video generation — uses IVideoClient with automatic fallback
import { createResilientVideoClient } from "#llm/providers.js";
const client = createResilientVideoClient();
const result = await client.generate({ prompt: "a sunset timelapse" });

// Chat/text — uses ILLMClient with automatic fallback
import { createClientForSelection, selectModel } from "#llm/providers.js";
const selection = selectModel({ explicitRole: "workhorse" });
const client = createClientForSelection(selection);
const response = await client.chat(messages);
```

All three patterns use the same architecture:
1. **Model selector** picks the primary provider based on role + available API keys
2. **Fallback chains** in `llm/model-selector.ts` define the fallback order per role
3. **Resilient wrappers** catch retryable errors (429, 500, 502, 503, 504, network) and try the next provider
