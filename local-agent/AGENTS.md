# Local Agent Package — Agent Instructions

## What This Package Does

The local agent runs on the user's Windows machine. It executes tools, manages the credential vault, stores memory, runs periodic background tasks (heartbeat, sleep cycle), and communicates with the cloud server via WebSocket. It **NEVER calls LLMs directly** — all reasoning goes through the server.

## Key Directories

| Directory | Purpose |
|-----------|---------|
| `src/tools/` | Tool definitions (`core-tools-extended.ts`) and handlers (`tool-handlers-*.ts`) |
| `src/tools/gui/` | GUI automation — browser (Playwright) + desktop (Python daemon via pywinauto) |
| `src/memory/` | Sleep cycle, store, instruction applier, prompts/skills |
| `src/heartbeat/` | Periodic awareness loop — reads `~/.bot/HEARTBEAT.md`, sends to server |
| `src/periodic/` | Unified periodic manager — coordinates heartbeat + sleep cycle |
| `src/handlers/` | WS message handlers for memory, discovery, resources |
| `src/index.ts` | Main entry — WS connection, message routing, lifecycle |
| `src/credential-vault.ts` | DPAPI vault + `srv:` blob storage |
| `src/credential-proxy.ts` | Client-side proxy — routes authenticated requests through server |
| `src/executor.ts` | Command executor — dispatches PowerShell, WSL, browser, file ops |
| `src/types.ts` | Local agent types — `HeartbeatResult`, `ExecutionType`, etc. |

## Tool System

### Definitions vs Handlers

- **Definitions** in `src/tools/core-tools-extended.ts` — arrays of `DotBotTool` objects grouped by category (`secretsTools`, `discordTools`, `searchTools`, `guiTools`, etc.)
- **Handlers** in `src/tools/tool-handlers-*.ts` — one file per category, exported as handler functions
- **Registry** in `src/tools/registry.ts` — aggregates all tool arrays, generates manifest for server
- **Executor** in `src/tools/tool-executor.ts` — dispatches tool calls to correct handler, handles `credentialRequired` auto-injection

### Adding a New Tool

1. Add `DotBotTool` definition to the appropriate array in `core-tools-extended.ts`
2. Add handler function in the matching `tool-handlers-*.ts` file
3. Wire the handler in `tool-executor.ts` dispatch
4. Add tests in `tool-handlers-*.test.ts`

### `credentialRequired` Pattern

Tools that need a credential (e.g., `discord.*` tools) declare `credentialRequired: "KEY_NAME"`. The executor:
1. Calls `resolveCredential(name)` from vault
2. If found (non-`srv:` blob): injects as `args.__credential`
3. If `srv:` blob: returns null → handler falls through to server proxy path

This is transparent to the LLM — it just calls the tool, credential routing is automatic.

### `secrets.prompt_user` — Required Parameters

This tool requires three params: `key_name`, `prompt`, AND `allowed_domain`. The `allowed_domain` is required for domain-scoped encryption. Missing it returns an error. The runtime is `"internal"` (not PowerShell).

## Credential Vault (`credential-vault.ts`)

- File: `~/.bot/vault.json` — `{ version: "1", credentials: { "KEY": "<blob>" } }`
- Two blob types: DPAPI (Windows-encrypted, decryptable locally) and `srv:` (server-encrypted, opaque)
- `vaultGet()` returns null for `srv:` blobs — they can only be used via the server proxy
- `resolveCredential()` chain: vault → `process.env` → `~/.bot/.env`
- Uses `execFileSync("powershell.exe", [...])` for DPAPI — no shell, no injection risk
- In-memory cache (`cachedVault`) — invalidated after every write

## Periodic System (`src/periodic/manager.ts`)

- Single coordinator for all background tasks (heartbeat, sleep cycle)
- **15-second poll loop**, **2-minute idle threshold** before any task runs
- **One task at a time** — overlap prevention via `currentlyRunning`
- Tasks register as `PeriodicTaskDef` with `intervalMs`, `initialDelayMs`, `canRun()` gate, `run()` function
- `notifyActivity()` resets idle clock on every user interaction

### Heartbeat (`src/heartbeat/heartbeat.ts`)

- Reads `~/.bot/HEARTBEAT.md`, sends to server for evaluation by personal-assistant persona
- Response contract: `HEARTBEAT_OK` = silence, anything else = alert user
- Exponential backoff on failures, capped at 30 minutes
- File watcher on HEARTBEAT.md for live reloads

### Sleep Cycle (`src/memory/sleep-cycle.ts`)

- 30-minute interval, consolidates conversations into mental models
- Sends `condense_request` to server, applies structured instructions locally
- Resolves open loops via `resolve_loop_request`

## GUI Automation (`src/tools/gui/`)

Two tracks:
- **Browser**: Playwright headless Chromium, persistent context at `~/.bot/browser-data/`
- **Desktop**: Persistent Python daemon (`gui_agent.py --daemon`), JSON-RPC over stdin/stdout

Desktop daemon features: window cache, SoM (Set-of-Marks) visual grounding, app launcher DB, keyboard shortcuts DB, post-action verification, dialog detection, multi-monitor DPI.

## WebSocket Message Routing (`src/index.ts`)

The main `onMessage` handler is a switch on `message.type`. Key credential routes:
- `credential_session_ready` → `handleSessionReady()`
- `credential_stored` → `handleCredentialStored()` → `vaultSetServerBlob()`
- `credential_proxy_response` → `handleProxyResponse()`
- `heartbeat_response` → routed to pending request handler

## Testing

- Run: `npx vitest run` from `local-agent/`
- Discord tool tests use mock fetch queue (`pushFetchResponse`), mock vault, mock proxy
- Credential tests mock `credential-vault` and `credential-proxy` modules
- Current count: ~578 tests across 22 test files

## Common Mistakes to Avoid

- Forgetting `.js` extension in import paths
- Calling LLMs directly from local agent code — all LLM calls go through server via WS
- Using `vaultGet()` for `srv:` credentials — it returns null by design; use `vaultGetBlob()` for proxy
- Adding new tool definitions without wiring the handler in `tool-executor.ts`
- Mutating `cachedVault` directly — always go through `vaultSet`/`vaultDelete` which invalidate cache
- Creating timers independently — use the periodic manager for background tasks
