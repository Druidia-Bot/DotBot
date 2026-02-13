# DotBot — Agent Instructions

## Project Overview

DotBot is a hybrid AI assistant: **cloud server** handles reasoning (LLM calls, routing, persona selection), **local agent** executes actions (tools, file ops, shell commands) on the user's Windows machine. All persistent state lives in `~/.bot/` on the user's machine. The server is stateless.

## Monorepo Structure

| Package | Purpose | Runtime |
|---------|---------|---------|
| `server/` | Cloud server — LLM orchestration, personas, WS handlers, credential encryption | Node.js (Hono HTTP + raw WS) |
| `local-agent/` | Local agent — tool execution, vault, memory, heartbeat, periodic tasks | Node.js (WS client) |
| `shared/` | Shared types and logging utilities | Library (imported by both) |
| `client/` | Browser UI — single `index.html` | Static |

## TypeScript Conventions

- **ESM everywhere** — `import`/`export` syntax, `.js` extensions in all import paths (even for `.ts` files). No CommonJS.
- **Target**: ES2022, `moduleResolution: "bundler"`, `strict: true`
- **Testing**: Vitest. Tests live next to code as `*.test.ts`. Run `npx vitest run` per package.
- **Type checking**: `npx tsc --noEmit` per package. Must pass before any change ships.
- **Naming**: `camelCase` for variables/functions, `PascalCase` for types/interfaces, `UPPER_SNAKE_CASE` for constants.
- **Imports at the top** — never import mid-file. If adding imports to an existing file, put them with the existing imports.

## Verification Before Completing Any Task

1. `npx tsc --noEmit` in both `server/` and `local-agent/` — zero errors
2. `npx vitest run` in both packages — all tests pass
3. Never delete or weaken existing tests without explicit direction

## Security — CRITICAL RULES

- **API keys NEVER appear in LLM prompts, tool results, or WebSocket messages.** They live in `process.env` on the server and are used only in HTTP Authorization headers.
- **Credential values NEVER appear in chat, logs, or memory.** Only credential NAMES (references) are safe to share.
- The `credential-vault.ts` stores encrypted blobs. `srv:` prefix = server-encrypted (AES-256-GCM). Other blobs = DPAPI-encrypted (Windows).
- `secrets.prompt_user` requires `allowed_domain` — credentials are cryptographically bound to their API domain via HKDF key derivation.
- When writing proxy/fetch code that handles credentials, NEVER log the decrypted value. NEVER include it in error messages.

## Architecture Boundaries

- **Server NEVER touches the filesystem** (except `~/.bot/server-data/master.key` for credential encryption)
- **Local agent NEVER calls LLMs directly** — all LLM calls go through the server via WebSocket
- **Memory is stored exclusively on the user's machine** — sent to server only as needed context per-request
- Communication between server and local agent is via a single **WebSocket** connection with typed `WSMessage` objects (`server/src/types.ts`)

## Tool Design Philosophy

- **Many specific tools over few general ones** — `create_file(path, content)` beats `bash("echo '...' > file.txt")`
- **Native function calling** — use the LLM provider's `tools` API parameter, not custom JSON parsing
- Tool definitions live in `local-agent/src/tools/core-tools-extended.ts`
- Tool handlers live in `local-agent/src/tools/tool-handlers-*.ts`
- Each tool: one clear action, explicit parameters, deterministic, fail loudly

## Persona System

- **Server internal personas**: `.md` files in `server/src/personas/internal/` with YAML frontmatter (`id`, `modelTier`, `tools`)
- **Intake personas** (receptionist, updater): classify/route and maintain memory. No tool access.
- **Worker personas** (junior-dev, senior-dev, researcher, etc.): used as style references by the persona writer.
- **Local user-defined personas**: `~/.bot/personas/{slug}/` — loaded by persona writer via `decision.localPersonaSlug`.
- The **persona writer** generates custom system prompts + selects specific tool IDs per task. Internal personas serve as templates.

## Model Selection

Four roles auto-selected per task via `selectModel()` in `server/src/llm/model-selector.ts`:
- **workhorse** (DeepSeek V3.2) — 98% of tasks
- **deep_context** (Gemini 3 Pro, 1M tokens) — large files, video, PDFs
- **architect** (Claude Opus 4.6) — complex reasoning, planning
- **local** (Qwen 2.5 0.5B) — offline fallback

All providers implement `ILLMClient` interface (`chat()` + `stream()`). Use `createClientForSelection(selectModel(...))` pattern — never construct clients directly.

## Code Style

- **Minimal edits** — match existing patterns (indentation, naming, comment style)
- **No unnecessary abstractions** — don't create a class when a function will do
- **Fail loudly** — specific errors with context: `log.warn("Tool failed", { toolName, personaId, error })`
- **No comments/documentation changes** unless explicitly asked
- **Flat files over databases** — personas, skills, models, threads are all `.md` or `.json` on disk

## Key Documentation

| Document | Path |
|----------|------|
| Architecture | `docs/ARCHITECTURE.md` |
| Coding Patterns | `docs/CODING_PATTERNS.md` |
| Credential Security | `docs/internal-notes/CREDENTIAL_SECURITY.md` |
| Discord Integration | `docs/internal-notes/DISCORD.md` |
| Heartbeat System | `docs/internal-notes/HEARTBEAT.md` |
| GUI Automation | `docs/FEATURE_GUI_AUTOMATION.md` |
