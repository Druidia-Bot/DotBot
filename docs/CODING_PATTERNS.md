# DotBot: Coding Patterns & Decisions

> Accuracy and repeatability over speed. Specific over general. Trust the model for reasoning, constrain it for actions.

This document captures the *why* behind DotBot's engineering patterns. Read alongside [Guiding Principles](./GUIDING_PRINCIPLES.md) for the product philosophy — especially on [data ownership](./GUIDING_PRINCIPLES.md#1-the-user-owns-everything), [security model](./GUIDING_PRINCIPLES.md#why-cant-prompt-injection-leak-api-keys), and [model selection](./GUIDING_PRINCIPLES.md#4-intelligence-is-a-utility).

---

## Many Specific Tools, Not Few General Ones

DotBot favors a **large catalog of narrow, well-defined tools** over a handful of powerful general-purpose tools.

A `create_file(path, content)` tool is more predictable than `bash("echo '...' > file.txt")`. The model doesn't have to figure out shell escaping, quoting, redirect syntax, or platform differences. It fills in two parameters and the tool handles the rest. Multiply that across 40+ tools and you get dramatically more reliable execution.

**The tradeoff is intentional:** more tools means a larger system prompt and slightly more tokens per request. We accept that cost because accuracy and repeatability matter more than latency. A tool call that works every time is worth more than a fast one that works 80% of the time.

**Both micro tools and big guns.** DotBot has `edit_file` for a single line change *and* `codegen_execute` to delegate entire projects to Claude Code. The model picks the right tool for the scope. Small tools for small jobs, heavy tools for heavy jobs.

### What makes a good tool:
- **One clear action** — does one thing, named for what it does
- **Explicit parameters** — no hidden behavior, no magic flags
- **Deterministic** — same inputs produce same outputs
- **Self-documenting** — name + params tell you exactly what happens
- **Fail loudly** — errors are specific and actionable, not swallowed

### When NOT to create a tool:
- If it's a one-off workflow → make it a Skill (SKILL.md)
- If it's just combining two existing tools → let the model chain them
- If the behavior varies wildly by context → it's not atomic enough

---

## Native Tool Calling

Use the LLM provider's **native function calling** (the `tools` API parameter) rather than custom response formats. The model was trained on this interface — it's the most reliable way to get structured tool calls.

- Tools are passed as structured `ToolDefinition[]` objects, not pasted into the system prompt as text
- The model returns structured `ToolCall` objects, not custom JSON we have to parse
- Tool results go back as `role: "tool"` messages with `tool_call_id`, not `role: "user"` strings
- This works across providers: OpenAI and DeepSeek support it natively, Anthropic's `tool_use` format is translated by our client layer

**Why this matters:** Custom response formats (XML, JSON mode) require the model to learn our schema from prompt instructions. Native tool calling uses the schema the model was trained on. Less confusion, fewer parse failures, better accuracy.

---

## Separation of Concerns

DotBot separates three things that most AI systems conflate:

| Layer | Responsibility | Where it runs |
|-------|---------------|---------------|
| **Reasoning** | LLM calls, routing, persona selection, planning | Cloud server |
| **Execution** | File ops, shell commands, tool dispatch | Local agent |
| **Memory** | Threads, mental models, skills, knowledge | Local filesystem (`~/.bot/`) |

The server never touches the filesystem. The local agent never calls LLMs. Memory is **stored** exclusively on the user's machine (sent to LLMs only as needed context per-request). Each layer has a single job and does it well.

### The WebSocket bridge

Server and local agent communicate over a single WebSocket connection. The server sends `ExecutionCommand` objects (tool ID + args); the local agent dispatches to the correct handler and returns results. This is a clean RPC boundary — the server doesn't know *how* tools execute, only *what* they're called.

### API key isolation (security by architecture)

API keys (LLM providers, image generation, premium tools) live exclusively in the server's `process.env`. They are used programmatically in HTTP Authorization headers and **never** appear in LLM prompts, tool results, or WebSocket messages. This makes prompt-injection-based key exfiltration structurally impossible in production:

1. **Keys are never in context** — the LLM cannot leak what it never sees
2. **Tools execute on the user's machine** — even a successful prompt injection runs commands on the local agent, which has no access to server environment variables
3. **Server has no self-inspection tools** — no tool reads server files, env vars, or source code
4. **Server-side operations (LLM calls, imagegen, premium tools) are opaque** — they use keys internally and return only sanitized results

This is defense in depth by architecture, not by prompt guardrails. The machine boundary between server and local agent is the security boundary.

### Split-knowledge credential proxy

User-provided credentials (Discord bot token, Brave Search API key, etc.) use a **split-knowledge** model where the encrypted blob lives on the client and the decryption key lives on the server. Neither side alone can access the plaintext.

```
Entry:   User → Server HTTPS page → AES-256-GCM encrypt → blob stored on client
Usage:   Client sends blob + request → Server decrypts → injects into HTTP header → makes API call → returns response
```

Key security properties:
- **Domain-scoped encryption** — each credential is cryptographically bound to its allowed API domain via HKDF key derivation. A blob encrypted for `discord.com` cannot be decrypted for `attacker.com`.
- **LLM never sees values** — only credential *names* and a `credentialConfigured: true/false` boolean appear in tool manifests
- **SSRF protection** — proxy validates request URLs against a blocklist (localhost, private IPs, cloud metadata endpoints)
- **Rate limiting + CSRF** — credential entry pages have rate limiting, CSRF protection, CSP headers, and `X-Frame-Options: DENY`

See [Guiding Principles — Split-Knowledge Credential Security](./GUIDING_PRINCIPLES.md#split-knowledge-credential-security) for the full architecture.

---

## Task-Based Model Selection

DotBot uses **multiple LLM providers simultaneously**, routing each request to the best model for that specific task. This replaces the old single-provider tier system.

### Five Model Roles

| Role | Provider | Model | Use Case |
|------|----------|-------|----------|
| **workhorse** | DeepSeek | `deepseek-chat` (V3.2) | 98% of tasks. Fast, cheap, very capable. |
| **deep_context** | Gemini | `gemini-3-pro-preview` | 1M token context. Video, large PDFs, entire codebases. |
| **architect** | Anthropic | `claude-opus-4-6` | Complex system design, planning, second opinions on code. |
| **gui_fast** | Gemini | `gemini-2.5-flash` | Low-latency GUI automation. Fast decisions, cheap. |
| **local** | node-llama-cpp | `qwen2.5-0.5b-instruct` | Offline fallback. Basic tasks when cloud is unavailable. |

### Selection Decision Tree (`selectModel()` in `llm/model-selector.ts`)

```
1. Explicit role override?  → use it
2. Offline?                 → local (Qwen 2.5 0.5B via node-llama-cpp)
3. Large files / >50K tokens? → deep_context (Gemini 3 Pro)
4. Architecture / planning / second opinion? → architect (Claude Opus 4.6)
5. Everything else          → workhorse (DeepSeek V3.2)
```

### Fallback Chains

If the preferred provider's API key is missing, the selector falls back automatically:
- **workhorse** → Gemini Flash → OpenAI → Anthropic Haiku → local
- **deep_context** → Claude Opus (200K) → DeepSeek (64K, degraded)
- **architect** → DeepSeek Reasoner → Gemini Pro
- **local** → DeepSeek (if online)

### Provider-Agnostic Interface

All LLM providers implement the same `ILLMClient` interface: `chat()` and `stream()`. Provider-specific details (Anthropic's system message separation, Gemini's `systemInstruction` field, tool format conversion, auth headers) are encapsulated in each client. Business logic never touches provider APIs directly.

`resolveModelAndClient()` in `llm/resolve.ts` runs `selectModel()`, then either reuses the current client (if same provider) or creates a new one via `createClientForSelection()`. This means a single request pipeline can transparently switch providers mid-execution.

---

## Persona Architecture

Different tasks need different thinking. A code review needs different instructions, tools, and model quality than writing a joke or debugging a Docker container.

### Two kinds of personas

**Server internal personas** are `.md` files in `server/src/personas/internal/` with YAML frontmatter (id, model tier, tool categories) and a system prompt body. These are the built-in workforce — receptionist, senior-dev, researcher, etc.

**Local user-defined personas** live in `~/.bot/personas/{slug}/` with a `persona.json` configuration file. Users can create them by dropping files or by asking DotBot (which uses the `personas.create` tool). Local personas are auto-discovered by the receptionist and can be routed to just like internal ones.

### Persona knowledge bases

Every persona can have its own **knowledge base** — a collection of structured JSON documents in `~/.bot/personas/{slug}/knowledge/`. When a persona handles a task, its knowledge index is injected into context so it knows what domain expertise it has access to.

This enables specialized personas with deep domain knowledge. A "Marketing Strategist" persona could have documents about brand guidelines, competitor analysis, and campaign history. A "Project Manager" persona could have architecture decisions, sprint plans, and team structure. The knowledge persists across sessions and grows over time.

General knowledge in `~/.bot/knowledge/` is available to all personas. Persona-specific knowledge is scoped — only loaded when that persona is active.

### Tool filtering per persona

Each persona declares which **tool categories** it can use: `tools: [filesystem, shell, codegen]`. The tool loop filters the full manifest to only include matching tools. This saves tokens (the model doesn't see 40 tools when it only needs 8) and prevents confusion (the model won't try to use browser tools when doing file operations).

Special values: `[all]` gives access to every tool category. `[none]` skips the tool loop entirely (used by intake personas).

### Intake vs. Worker personas

- **Intake personas** (receptionist, updater) manage the pipeline — they classify, route, and maintain memory. They don't use tools.
- **Worker personas** (junior-dev, senior-dev, researcher, writer, etc.) serve as style references for the persona writer. They have tool access and domain-specific prompts.

This separation means routing logic never leaks into execution logic.

---

## Flat Files Over Databases

DotBot stores almost everything as markdown or JSON files on disk:
- Personas → `.md` files (server internal) or `persona.json` (local user-defined)
- Skills → `SKILL.md` files
- Mental models → JSON files
- Threads → JSON files
- Knowledge → `.json` files (structured, with `_meta` key for metadata)

**Why not a database?**
- **Human-readable** — open in any editor, inspect with `cat`
- **Git-friendly** — diff, merge, version control
- **Additive** — drop a file and it works, delete it and it's gone
- **Portable** — `cp -r ~/.bot/ /new/machine/` and everything comes with you
- **No migrations** — new fields are optional, old files still parse
- **Git-syncable** — planned: back `~/.bot/memory/` to a private git repo for versioned, cross-machine memory sync

The one exception: SQLite for server-side user/device management, where relational queries and transactions matter.

---

## Background Agent Tasks

Action requests spawn **background agent tasks** rather than blocking the main thread. The user gets an immediate acknowledgment ("I've started junior-dev on your request") and can send corrections while the task runs.

Each background task has:
- A unique `agentTaskId` for progress tracking
- A scoped runner with the correct ID injected into all progress messages
- An injection queue for mid-task user corrections
- Progress events streamed to the client via WebSocket

**Why background?** Tool loops can run 20+ iterations over several minutes. Blocking the UI that whole time is unacceptable. Background tasks let the user keep chatting, send corrections, or start new work.

---

## Memory Is the Differentiator

Most AI assistants are stateless — they forget everything between sessions. DotBot's memory system is what makes it feel like a real assistant:

- **Mental models** — structured knowledge about entities (people, projects, preferences) that persists forever
- **Threads** — conversation history organized by topic, not by session
- **Skills** — learned workflows that the model can invoke in future conversations
- **Knowledge** — structured JSON documents that give personas domain expertise

The **sleep cycle** (cron job on the local agent) processes raw conversation threads into distilled mental models — extracting facts, beliefs, preferences, and constraints. Over time, the system builds a deep understanding of the user's world without being told twice.

### Knowledge retrieval pattern: skeleton-first

Knowledge documents can be large — thousands of words of API reference, tutorial steps, or competitive analysis. Loading full documents into the LLM's context window wastes tokens and degrades performance.

Instead, DotBot uses **skeleton-first retrieval**:
1. `list_knowledge` shows a compact skeleton — just the keys with truncated values
2. The LLM sees the *shape* of what's known: which topics exist, roughly how much detail each has
3. The LLM requests only the sections it needs via `read_knowledge` with dot-notation (`section: "api.endpoints.auth"`)
4. `search_knowledge` finds matching sections by keyword across all documents

This keeps context windows lean while giving the LLM full access to deep knowledge on demand.

### Knowledge ingestion: server-side processing

The `knowledge.ingest` tool is a **server-side executor** — it runs on the cloud server, not the local agent. This is the same routing pattern used by premium tools and image generation:

1. Tool loop detects `toolId === "knowledge.ingest"` → routes to server callback
2. Server fetches the Gemini API key and calls the ingestion engine
3. Text/HTML content is sent inline to Gemini for extraction
4. Binary content (PDFs, images, video, audio) is uploaded to Gemini Files API, processed, then immediately deleted
5. Gemini returns structured JSON with `responseMimeType: "application/json"`
6. The result flows back through the tool loop for the LLM to save via `knowledge.save`

This pattern — where certain tools execute server-side while most execute locally — is a key architectural decision. Server-side tools use DotBot's API keys (not the user's) and are gated by specific routing checks in the tool loop.

---

## Pipeline Module Structure

The server pipeline is a linear chain of independent modules, each in its own folder:

```
Intake → Receptionist → Persona Picker → Planner → Step Executor
```

Each module follows the same structural conventions so new pipeline stages are easy to add and existing ones are easy to find.

### Folder layout

Every pipeline module is a folder under `server/src/` containing:

- **`types.ts`** — Input, output, and internal interfaces shared across the module's files. The module's public contract lives here.
- **`*.md`** — Prompt templates using `|* FieldName *|` placeholders, loaded at runtime by `loadPrompt()`. Prompts are never hardcoded in TypeScript.
- **`*.schema.json`** — JSON schemas that constrain LLM output structure. Passed to the LLM via `responseSchema` so the model knows the exact shape expected.
- **Orchestrator `.ts`** — The main entry point (e.g., `receptionist.ts`, `planner.ts`). Coordinates the module's workflow: load prompt, call LLM, parse response, produce typed output.
- **Supporting `.ts` files** — Sub-concerns split into focused files: output builders, tool wrappers, data fetchers, formatters. Each file earns its existence by encapsulating a distinct responsibility.

Simpler modules (like `intake/`) may omit `types.ts` or the schema file if they don't need them. The pattern scales up or down.

### LLM call pattern

All modules that call an LLM follow the same sequence:

1. **Resolve model** — `resolveModelAndClient(llm, { explicitRole: "..." })` selects the right provider and model for the task
2. **Load prompt + schema in parallel** — `Promise.all([loadPrompt(...), loadSchema(...)])` to avoid serial I/O
3. **Inject context via placeholders** — Formatter functions produce strings for each `|* Field *|` in the template
4. **Call LLM with structured output** — `responseFormat: "json_object"` + `responseSchema: { name, schema }` so the model returns validated JSON
5. **Parse defensively** — Extract JSON with regex fallback, return typed result or graceful error

### Formatter conventions

- Formatters are standalone functions (not methods) that take typed input and return a string
- Use `[...lines].join("\n")` for multi-line output, not template literals with embedded newlines
- Extract complex inline chains into named variables for readability
- Empty/missing data should produce a meaningful fallback string, not an empty string

### Module boundaries

Each module produces a typed result that feeds into the next module. Modules do not import each other's internals — they communicate through their public types. The pipeline orchestrator (`prompt-handler.ts`) is the only file that calls modules in sequence and threads results between them.

WebSocket handlers are thin wrappers: dynamic-import the module, pass the payload, return the result. No business logic in handlers.

### Prompt template guidelines

- **Identity first** — Inject `|* Identity *|` at the top so the LLM knows who it is
- **Context sections** — Use markdown headers (`## Thread`, `## Relevant Models`) to structure injected data
- **Behavioral rules in the prompt, structure in the schema** — The `.md` file says *what* to do and *how* to think; the `.schema.json` says *what shape* to return. Don't duplicate the schema as prose in the prompt.
- **Keep prompts focused** — Each prompt has one job. If a module needs two LLM calls with different instructions (like persona-picker's pick + write phases), use two separate `.md` files.

### The condenser and sleep cycle

The `condenser/` module follows the same pattern but runs outside the main pipeline — it's called by the local agent's sleep cycle via WebSocket. The condenser and loop-resolver are independent sub-modules (separate `.ts`, `.md`, and `.schema.json` files) that share types but not barrel exports.

---

## Self-Improving Tool Catalog

Tools aren't just built-in — the system can **discover, test, and save new tools at runtime**. When the model finds a useful free API, it can:

1. Test it with `http_request` to verify it works
2. Save it with `save_tool` to register it permanently
3. Future conversations automatically have the tool available

This means the tool catalog grows organically based on what the user actually needs. The model earned the tool by proving it works — never save untested tools.

---

## Code Style & Conventions

### TypeScript ESM everywhere
Both server and local agent use TypeScript with ES module syntax (`import`/`export`, `.js` extensions in imports). No CommonJS, no mixed module systems.

### Minimal edits
When modifying existing code, prefer targeted edits over rewrites. Match existing patterns — indentation, naming, comment style. If the file uses `camelCase`, use `camelCase`. If it has JSDoc, add JSDoc.

### Error handling
Fail loudly with specific errors. Never swallow exceptions silently. Log enough context to debug without reading the code:
```typescript
log.warn(`Tool ${toolName} failed`, { personaId, error: errorMsg });
```

### Testing
Vitest for all tests. Tests live next to the code they test (`*.test.ts`). Run `npx tsc --noEmit` for type checking, `npx vitest run` for tests. Both must pass before any change ships.

### No unnecessary abstractions
Don't create a class when a function will do. Don't create a function when inline code is clearer. Every abstraction must earn its existence by being used in 2+ places or by encapsulating genuine complexity.

---

## Decision Log

| Decision | Chosen | Rejected | Why |
|----------|--------|----------|-----|
| Tool granularity | Many specific tools | Few general tools (bash, read, write) | Accuracy and repeatability > latency |
| Tool calling format | Native function calling | Custom JSON / XML | Model trained on native format; more reliable |
| LLM response format | Structured tool calls | Free-form text + parsing | Eliminates parsing failures |
| Data storage | Flat files (md/JSON) | Database | Human-readable, portable, git-friendly |
| State location | Local agent only | Server memory | Privacy, scalability, user ownership |
| Agent architecture | Many specialized personas | One god agent | Focused prompts > bloated prompts |
| Task execution | Background with progress | Blocking | UI stays responsive during long tasks |
| Tool discovery | Self-learning (test → save) | Hardcoded catalog only | System grows with user needs |
| Provider support | Abstracted interface | Provider-specific code | Swap with config, not code |
| API key security | Architectural isolation (keys never in LLM context) | Prompt guardrails / output filtering | Machine boundary is unforgeable; prompt rules can be bypassed |
| Credential storage | Split-knowledge (encrypted blob on client, key on server) | Local encryption (DPAPI) / plaintext in .env | Neither side alone can access plaintext; domain-scoped; cross-platform |
| Chat channel security | Untrusted input (user ID verification, source tags, confirmation) | Trusted input (execute anything from the channel) | Stolen bot token ≠ machine access; defense in depth |
| Model selection | Task-based multi-provider (5 roles) | Single provider / manual tier | Different tasks need different strengths; auto-routing beats manual config |
| Knowledge format | Structured JSON with skeleton retrieval | Flat markdown files | Section-level access, search, metadata; context-efficient |
| Knowledge ingestion | Server-side Gemini processing | Client-side parsing | Handles binary (PDF, video, audio); uses server API keys |
| Temp email provider | mail.tm (free, no API key, local-only) | Self-hosted SMTP / paid provider | Zero setup, no credentials, no server involvement; disposable by design |
| Identity email relay | Separate repo (Cloudflare Worker) | Bundled in open-source DotBot | Central service with infrastructure costs shouldn't be in the OSS runtime |
| Pipeline module structure | Folder per stage (types + prompt + schema + orchestrator) | Monolithic files | Prompts are editable without touching TS; schemas enforce structure; concerns stay separated |

---

*Last Updated: February 14, 2026*
