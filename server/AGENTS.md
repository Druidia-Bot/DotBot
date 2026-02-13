# Server Package — Agent Instructions

## What This Package Does

The server handles ALL reasoning — LLM calls, persona routing, planning, credential encryption, and WebSocket communication with the local agent. It is **stateless**: processes a request and forgets. No filesystem access except `~/.bot/server-data/master.key`.

## Key Directories

| Directory | Purpose |
|-----------|---------|
| `src/agents/` | Pipeline, execution, tool loop, persona writer, orchestrator, spawned agents |
| `src/credentials/` | Split-knowledge credential system (crypto, sessions, routes, proxy, handlers) |
| `src/llm/` | LLM provider clients, model selector, resilient client wrapper |
| `src/personas/` | Persona loader + all persona `.md` files (intake + internal workers) |
| `src/ws/` | WebSocket server, device management, message handlers (prompt, heartbeat, bridge) |
| `src/scheduler/` | Deferred task scheduler (15s poll) |
| `src/knowledge/` | Knowledge ingestion (Gemini-powered, server-side) |
| `src/types.ts` | All shared types — `WSMessage`, `WSMessageType`, `HeartbeatResult`, etc. |

## LLM Client Patterns

- All providers implement `ILLMClient` with `chat()` and `stream()` methods
- **ALWAYS** use `createClientForSelection(selectModel(...))` — never construct provider clients directly
- Provider-specific quirks (Anthropic system messages, Gemini systemInstruction, tool format translation) are encapsulated in each client — business logic never touches provider APIs
- The `ResilientLLMClient` wraps any client with retry + fallback chain logic

## WebSocket Message Handling

- All WS messages are typed via `WSMessage` with `type`, `id`, `timestamp`, `payload`
- Handler functions live in `src/ws/` — one file per concern (prompt-handler, heartbeat-handler, device-bridge)
- New message types must be added to `WSMessageType` union in `src/types.ts`
- The main WS router is in `src/ws/server.ts` — a switch on `message.type`

## Persona Files

- Internal personas: `src/personas/internal/*.md` with YAML frontmatter
- Intake personas: `src/personas/intake/*.md` (receptionist, updater)
- Frontmatter fields: `id`, `name`, `type`, `modelTier`, `description`, `tools` (array of categories)
- Load via `getPersona(id)` from `src/personas/loader.ts` — never read `.md` files directly

## Credential System (src/credentials/)

- `crypto.ts` — AES-256-GCM encryption with HKDF key derivation. Domain baked into key via `info` param.
- `sessions.ts` — One-time ephemeral sessions for credential entry. 10-min TTL, in-memory Map.
- `routes.ts` — HTTP entry page with CSP headers, CSRF protection, rate limiting.
- `proxy.ts` — Decrypts credential + makes API call. SSRF protection validates all URLs.
- `handlers.ts` — WS handlers for `credential_session_request` and `credential_proxy_request`.
- **NEVER log decrypted credential values. NEVER include them in error messages.**

## Pipeline Flow (src/agents/)

1. `prompt-handler.ts` receives WS message → `pipeline.ts:executeV2Pipeline()`
2. Short path check (greetings/acks) → follow-up routing (conversation isolation)
3. `intake.ts:runReceptionist()` classifies request, picks persona hint
4. `persona-writer.ts:writePersonas()` generates custom system prompts + selects tool IDs per task
5. `orchestrator.ts:executeWithSpawnedAgents()` spawns isolated agents with curated tools
6. `execution.ts:executeWithPersona()` runs each agent through `tool-loop.ts`
7. Council review runs post-execution if `councilNeeded` (optional)
8. Tool execution requests go to client via `device-bridge.ts` (`sendExecutionCommand`)

## Testing

- Run: `npx vitest run` from `server/`
- Tests use `vi.mock()` for external deps, `vi.fn()` for stubs
- Credential tests use `_setMasterKeyForTesting()` / `_clearMasterKey()`
- Rate limit tests use `_clearRateLimits()`
- Current count: ~346 tests across 16 test files

## Common Mistakes to Avoid

- Using `createLLMClient()` instead of `createClientForSelection(selectModel(...))` — wrong client pattern
- Forgetting `.js` extension in import paths — will compile but fail at runtime
- Adding new WS message types without updating `WSMessageType` union in `types.ts`
- Putting filesystem operations in server code — only the local agent touches the filesystem
- Logging credential values anywhere — even in debug/error logs
