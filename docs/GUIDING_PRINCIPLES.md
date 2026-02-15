# DotBot: Guiding Principles

> Your memory lives on your machine. Intelligence runs in the cloud. Actions happen locally. The system improves itself.

This document captures DotBot's product philosophy and design decisions. For engineering patterns, see [Coding Patterns](./CODING_PATTERNS.md).

---

## What DotBot Is

DotBot is a hybrid AI assistant that separates **thinking** from **doing** from **remembering**.

- **Cloud server** handles reasoning, persona routing, and LLM orchestration. It is stateless — it processes a request and forgets.
- **Local agent** executes commands on the user's machine, manages files, runs scripts, and stores all persistent state.
- **User's data** lives entirely in `~/.bot/` on their machine. Personas, skills, mental models, conversation threads — all local, all theirs.

This isn't a chatbot. It's a system that grows with the user — learning their world, building skills, remembering context, and becoming more capable over time.

---

## Core Principles

### 1. The User Owns Everything

All data lives on the user's machine in `~/.bot/`. The cloud server is a processing layer — it never persists user data. If the user unplugs from the cloud, their entire knowledge base, skills, and history remain intact on their machine.

This is non-negotiable. The user's memory, preferences, mental models, and learned skills are theirs. Period.

### 2. Accuracy and Consistency Over Speed

Every design decision prioritizes **getting the right answer reliably** over getting a fast answer. This is the engineering value that underpins the entire system:

- **Many specific tools over few general ones** — a `create_file(path, content)` call works every time; a `bash("echo '...' > file")` call works 80% of the time. We accept higher token cost for higher reliability.
- **Structured output over free-form parsing** — JSON schemas and native function calling eliminate parse failures. The LLM returns validated structure, not prose we have to regex.
- **Multi-pass pipelines over single-shot** — intake classifies, receptionist gathers context, persona picker selects expertise, planner decomposes, executor acts. Each pass adds accuracy. We don't skip passes to save time.
- **Typed boundaries between modules** — every pipeline stage produces a typed result that the next stage consumes. Explicit contracts catch errors at boundaries, not three stages later.
- **Defensive execution** — stuck detection, result-aware warnings, force-escalation, synthesis passes. The system monitors its own execution and intervenes when something isn't working rather than silently failing.

Latency is a secondary concern. A response that takes 30 seconds and is correct is worth more than a response that takes 5 seconds and is wrong. Users trust systems that are reliably right; they stop trusting systems that are occasionally fast but unpredictable.

### 3. Additive by Design

Drop a `.md` file and the system picks it up. Remove it and it's gone. No config files to edit, no databases to migrate, no services to restart.

- Personas are `.md` files in `~/.bot/personas/` or JSON directories in `~/.bot/personas/{slug}/`
- Skills are `SKILL.md` files in `~/.bot/skills/{slug}/`
- Councils are files in `~/.bot/councils/`
- Knowledge is `.json` files in `~/.bot/knowledge/` (general) or `~/.bot/personas/{slug}/knowledge/` (per-persona)

The system discovers what exists on disk and adapts. This makes DotBot infinitely extensible without requiring code changes.

### 4. Specialized Workers, Not One God Agent

Different tasks need different thinking. A code review requires different expertise than writing marketing copy or debugging a Docker container. DotBot uses specialized personas — each with its own system prompt, tool access, and model tier — rather than one monolithic agent trying to be everything.

The receptionist classifies and routes. Workers execute. Councils optionally review. This separation produces better results than a single agent with a bloated system prompt.

### 5. Intelligence is a Utility

Users don't pick models. They don't configure temperature or max tokens. They describe what they want and the system **automatically selects the right model** based on what the task requires. The complexity is behind the curtain.

#### Five Model Roles

| Role | Model | When It's Used |
|------|-------|----------------|
| **Workhorse** | DeepSeek V3.2 | 98% of tasks — fast, cheap, very capable |
| **Deep Context** | Gemini 3 Pro (1M tokens) | Massive prompts, video, PDFs, large codebases |
| **Architect** | Claude Opus 4.6 | Complex system design, planning, second opinions on code |
| **GUI Fast** | Gemini 2.5 Flash | Low-latency browser and desktop automation |
| **Local** | Qwen 2.5 0.5B (node-llama-cpp) | Offline fallback — works without internet |

The `selectModel()` function examines task characteristics — estimated token count, file types, task complexity, connectivity — and picks the right role. If the preferred provider is unavailable, a fallback chain kicks in automatically:

- **workhorse** → Gemini Flash → OpenAI Mini → Haiku → local
- **deep_context** → Claude Opus → DeepSeek (degraded, 64K ctx)
- **architect** → DeepSeek Reasoner → Gemini Pro
- **gui_fast** → OpenAI Mini → DeepSeek → local
- **local** → DeepSeek (if online)

Multiple providers are registered at startup. The system uses **all of them** simultaneously, routing each request to the best model for that specific task. This isn't provider-agnostic — it's provider-*optimal*. See [Coding Patterns — Task-Based Model Selection](./CODING_PATTERNS.md#task-based-model-selection).

### 6. Memory Makes the Difference

Stateless AI assistants forget everything between sessions. DotBot doesn't. Every conversation contributes to an evolving understanding of the user's world:

- **Mental models** — structured knowledge about people, projects, places, preferences
- **Threads** — conversation history organized by topic
- **Skills** — learned workflows and instructions that persist across sessions
- **Knowledge** — structured JSON documents that give personas domain expertise (see below)

The sleep cycle condenses conversations into mental models. Over time, DotBot knows who Billy is, what the user's tech stack is, and how they prefer their code formatted — without being told twice.

### 7. Knowledge Is Structured and Retrievable

DotBot's knowledge system stores information as **structured JSON documents** — not flat text dumps. Each document is a JSON object where keys are meaningful concepts and values are exhaustive detail. A `_meta` key holds title, description, tags, source URL, and timestamp.

Knowledge can be **general** (available to all personas in `~/.bot/knowledge/`) or **persona-specific** (scoped to one persona in `~/.bot/personas/{slug}/knowledge/`). This means a Marketing Strategist persona can have brand guidelines, competitor analysis, and campaign history — knowledge that's irrelevant to the Developer persona.

**Skeleton-first retrieval** keeps context windows lean. Instead of loading entire documents, the system shows the LLM a compact skeleton — just keys and truncated values — so it can see the *shape* of what's known and request only the sections it needs. Section-level access via dot-notation (`"api.endpoints.auth"`) means the LLM reads exactly what's relevant, not the entire document.

**Ingestion from any source.** The `knowledge.ingest` tool processes URLs, PDFs, images, video, and audio into structured JSON using the Gemini API. Binary content is uploaded to Gemini's Files API, processed, and immediately deleted. The result is a structured knowledge document ready to save — every fact, example, and edge case captured.

### 8. Tools Are First-Class Citizens

DotBot doesn't just chat — it acts. 42+ core tools across filesystem, shell, network, search, browser, and more. The tool system is extensible:

- **Core tools** ship built-in (filesystem, shell, http, etc.)
- **Learned tools** are discovered and saved at runtime (API integrations)
- **Skills** are reusable instruction sets (SKILL.md standard)
- **Premium tools** access paid APIs through the server

Personas declare which tool categories they can use. The system filters tools per-persona to avoid confusion and save tokens.

### 9. The System Improves Itself

DotBot is designed to be self-improving. In Admin Mode (with access to the source repository), DotBot can modify its own code — creating new personas, improving prompts, fixing bugs, adding features — following a safe git-based workflow with testing and rollback.

In Client Mode (user installations), DotBot improves locally — creating skills, tuning persona knowledge, and adapting to the user's needs without modifying core code.

Self-improvement follows strict rules: branch, change, test, verify, merge or rollback. Never modify production directly. Never ship untested changes.

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  User's Machine                   │
│                                                   │
│  ~/.bot/                                          │
│  ├── personas/     ← custom personas + knowledge  │
│  │   └── {slug}/knowledge/ ← per-persona KB       │
│  ├── knowledge/    ← general knowledge base       │
│  ├── councils/     ← review teams                 │
│  ├── skills/       ← SKILL.md instruction sets    │
│  ├── tools/        ← learned API integrations     │
│  └── memory/       ← threads, mental models       │
│                                                   │
│  ┌─────────────────────────────────────────────┐  │
│  │            DotBot Local Agent               │  │
│  │  • Executes tools (files, shell, http...)   │  │
│  │  • Manages ~/.bot/ storage                  │  │
│  │  • Bootstraps defaults on first run         │  │
│  │  • Owns all persistent state                │  │
│  └──────────────────┬──────────────────────────┘  │
└─────────────────────┼────────────────────────────┘
                      │ WebSocket
┌─────────────────────▼────────────────────────────┐
│              DotBot Cloud Server                  │
│                                                   │
│  Intake: receptionist → classify + route           │
│          persona writer → generate agent prompts   │
│          updater → write memory deltas             │
│                                                   │
│  Workers: senior-dev, junior-dev, writer,         │
│           researcher, code-reviewer, comedian,    │
│           sysadmin, data-analyst, general,         │
│           core-dev                                 │
│                                                   │
│  Councils: optional review layers                 │
│                                                   │
│  LLM: DeepSeek / Anthropic / OpenAI / Gemini     │
│                                                   │
│  State: ZERO. Processes requests and forgets.     │
└──────────────────────────────────────────────────┘
```

### Request Flow

1. User sends a message
2. **Receptionist** classifies intent, picks persona, assigns thread, decides memory action
3. **Worker persona** executes (with tool loop if needed)
4. **Council** optionally reviews and refines the output
5. **Updater** writes memory deltas (mental models, thread history) in the background
6. Response returned to user. Server retains nothing.

---

## Self-Improvement Model

DotBot is designed to improve itself. It operates in three modes depending on what source code is available:

### Admin Mode

The developer has access to the full source repository (both `server/` and `local-agent/`). DotBot can modify server code, local-agent code, personas, prompts, skills, and infrastructure. Changes follow a strict workflow:

1. Work in a separate working directory (`~/.bot/workspace/dotbot/`), never the primary repo
2. Sync with upstream, create a feature branch
3. Make changes — read before writing, minimal edits, match existing style
4. Run `tsc --noEmit` (both projects) to verify compilation
5. Run `vitest run` (both projects) to verify tests pass
6. If all pass → commit and merge. If any fail → recursive fix loop (max 5 attempts), then rollback.

### Client Source Mode

Users who have the local-agent source code (cloned from the repo) can modify the **local-agent's TypeScript source** — tool handlers, memory logic, new tools, default skills — compile it, and deploy live updates. Server code remains off-limits.

The deployment uses a **staged update** workflow with the launcher wrapper:
1. Compile changes in the workspace
2. Stage the build to `~/.bot/workspace/staged-dist/`
3. Write an `update-pending` marker file
4. The launcher detects the marker, backs up current code, promotes the staged build, and restarts
5. If the new code crashes within 10 seconds → **automatic rollback** to the backup

This gives every user the power to extend and improve their own agent without touching server infrastructure.

### Client Content Mode

Users without source code access can still improve DotBot by modifying content in `~/.bot/`:

- Create and modify skills (`~/.bot/skills/`)
- Add personas and knowledge docs (`~/.bot/personas/`)
- Build knowledge bases from URLs, PDFs, and other sources (`~/.bot/knowledge/`)
- Define councils (`~/.bot/councils/`)
- Save learned tools (`~/.bot/tools/`)

### Upstream Compatibility

The primary repo remains the source of truth. Users can pull upstream updates and merge them with their local modifications. Upstream structural changes take priority; user improvements (prompt text, persona tweaks, skill content) layer on top.

---

## Design Decisions

### Why JSON for Knowledge, Not Plain Markdown?

Knowledge documents were originally markdown files. They became structured JSON because:

- **Section-level retrieval** — dot-notation access (`"api.endpoints"`) lets the LLM read exactly what it needs instead of the whole document
- **Skeleton generation** — keys + truncated values give the LLM the shape of knowledge without the weight
- **Machine-processable** — search, filter, and merge operations work on structured data
- **Metadata built-in** — `_meta` key holds title, tags, source URL, timestamps
- **Still human-readable** — formatted JSON is easy to inspect and edit

Plain markdown remains the format for personas (system prompts), skills (SKILL.md), and other content where structure matters less than natural language flow.

### Why Markdown Files, Not a Database?

- **Human-readable** — users can inspect and edit their data with any text editor
- **Git-friendly** — changes are diffable, mergeable, and version-controllable
- **Additive** — drop a file and it works; no migrations, no schema changes
- **Portable** — copy `~/.bot/` to a new machine and everything comes with you

### Why Personas Instead of One Agent?

- **Better results** — a focused system prompt outperforms a bloated one
- **Right-sized models** — use fast/cheap models for simple tasks, smart models for complex ones
- **Clear boundaries** — each persona knows what it does and what it doesn't
- **Extensible** — add a persona for any new capability without touching existing ones

### Why Stateless Server?

- **Scalability** — no user state in memory means horizontal scaling is trivial
- **Privacy** — nothing to leak, nothing to breach, nothing to subpoena
- **Simplicity** — the server is a pure function: request in, response out

### Why Can't Prompt Injection Leak API Keys?

The architecture makes API key exfiltration **structurally impossible** (assuming production deployment where server and local agent run on separate machines):

- **API keys are never in the LLM context.** They're read from `process.env` at module load and used only in HTTP Authorization headers for programmatic API calls. No key ever appears in a system prompt, user message, or tool result.
- **All tool execution happens on the user's machine.** Even if a prompt injection tricks the LLM into running `echo $OPENAI_API_KEY` or reading `.env` files, that command executes on the local agent — which doesn't have the server's keys.
- **Server-side operations are opaque.** LLM calls, premium tools, and image generation all use keys internally and return only sanitized results. The LLM sees the output, never the authentication.
- **The server has no self-inspection tools.** There is no tool that reads server-side files, environment variables, or source code. The server sends commands *out* to the local agent — it never executes commands on itself.

This is defense in depth by architecture, not by prompt engineering. No amount of clever prompting can cross the machine boundary.

### Split-Knowledge Credential Security

When a user provides a third-party credential (like a Discord bot token or Brave Search API key), DotBot uses a **split-knowledge architecture** where neither the client nor the server alone can access the plaintext:

| Component | Location | Has |
|-----------|----------|-----|
| Encrypted blob (`srv:...`) | Client vault (`~/.bot/vault.json`) | Ciphertext — useless without server key |
| Master key | Server only | Decryption — useless without blob |
| Plaintext credential | Neither (transiently in server RAM during API calls) | Milliseconds only |

**Domain-scoped encryption.** Each credential is cryptographically bound to its allowed API domain via HKDF key derivation. A Discord bot token encrypted for `discord.com` cannot be decrypted for `attacker.com` — the wrong domain produces the wrong key, and AES-GCM authentication fails. This is enforced at the cryptographic level, not by runtime checks.

**How credentials are used at runtime:**
1. A tool needs to call an API (e.g., Discord)
2. The local agent reads the opaque encrypted blob from its vault
3. The blob + the HTTP request are sent to the server via WebSocket
4. The server decrypts the blob, injects the credential into the request's Authorization header, makes the API call, and returns the response
5. The plaintext credential exists only in server memory for the duration of the HTTP call

The LLM never sees credential values — only credential *names* and whether they're configured. See [Coding Patterns — API Key Isolation](./CODING_PATTERNS.md#api-key-isolation-security-by-architecture).

### Why Chat Channels Are Not Trusted Inputs

When an AI assistant listens on Discord and faithfully executes commands, the bot token becomes a remote access key to the user's machine. Most implementations have zero mitigation — no user verification, no action-level permissions, no confirmation for destructive operations.

DotBot treats the chat channel as an **untrusted input** — the same way a web app treats HTTP requests:

1. **Layer 1 — User identity:** Only messages from the authorized Discord user ID are processed. An attacker with a stolen bot token but a different Discord account is silently ignored.
2. **Layer 2 — Source-tagged permissions:** Prompts from Discord carry `source: "discord"`. The server enforces reduced tool access for remote prompts.
3. **Layer 3 — Destructive action confirmation:** Shell commands, file writes, and system changes triggered from Discord require explicit user confirmation before execution.

### Why Skills Over Hardcoded Features?

Skills are instruction sets, not code. They guide the LLM's behavior without requiring code changes:
- New capabilities ship as `.md` files
- Users can create their own
- Skills compose with tools — a skill can reference any tool in the system
- The SKILL.md format is a standard (shared with Claude Code)

---

## Technical Stack

| Component | Technology |
|-----------|------------|
| Local Agent | Node.js + TypeScript (ESM) |
| Server | Node.js + TypeScript (ESM) |
| Communication | WebSocket (bidirectional) |
| Database | SQLite (server-side, user management) |
| User Storage | Flat files in `~/.bot/` (markdown, JSON) |
| LLM Providers | DeepSeek (default), Anthropic, OpenAI, Gemini |
| Build | TypeScript compiler (`tsc`) |
| Tests | Vitest |
| Package Manager | npm with workspaces |

---

## What Success Looks Like

DotBot succeeds when:

1. The user forgets they're talking to an AI because it remembers everything and just *knows* their context
2. The system gives the right answer consistently — even if it takes longer to get there
3. Adding a new capability is as simple as dropping a `.md` file
4. The system gets better at its job every day — through learned skills, refined personas, growing knowledge bases, and evolving memory
5. The user's data is theirs, always, completely, without compromise
6. The developer can ask DotBot to improve itself, and it does — safely, with tests, with rollback

---

*Last Updated: February 14, 2026*
*Version: 1.2*
