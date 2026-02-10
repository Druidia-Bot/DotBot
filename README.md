# DotBot

> Your memory lives on your machine. Intelligence runs in the cloud. Actions happen locally.

A hybrid AI assistant that **remembers everything, owns nothing, and gets better every day**. The cloud handles reasoning; your local agent executes commands, stores memory, and manages skills — all on your machine, under your control.

For the product philosophy, see [Guiding Principles](docs/GUIDING_PRINCIPLES.md). For engineering decisions, see [Coding Patterns](docs/CODING_PATTERNS.md).

---

## Why DotBot Exists

We wanted to build an **agentic AI framework** that could do three things existing tools couldn't:

1. **Run via a lightweight client on a Windows machine** — a local agent that executes tools, manages files, stores memory, and connects to a cloud server for reasoning. No heavy IDE integration, no Docker containers, no VM overhead. Just a Node.js process that makes your machine AI-capable.

2. **Act as a bridge to control one or more APIs from a web interface** — route tasks through specialized personas, each with curated tool access and the right model tier. The server handles orchestration; the client handles execution. Connect from a browser, Discord, or any WebSocket client.

3. **Remember everything and own nothing** — persistent memory that grows over time, stored entirely on the user's machine as flat files. The cloud server is stateless. Your data never leaves your control.

Existing AI assistants fail at this because they're built as monoliths — one agent, one model, one context window, data locked in a vendor's cloud. DotBot was designed from day one as a **distributed system** where reasoning, execution, and memory are architecturally separated across machine boundaries. That separation is what makes the security model, the multi-model routing, and the data ownership guarantees possible.

---

## How DotBot Is Different

### Own Your Data — Really

Everything lives in `~/.bot/` on **your machine**. Personas, skills, mental models, knowledge bases, conversation history — it's all flat files (markdown and JSON) that you can read with any text editor, back up with git, and copy to a new machine with `cp -r`.

The cloud server is **stateless**. It processes a request and forgets. There is no user database, no conversation store, no analytics pipeline. If you unplug from the cloud tomorrow, your entire history stays intact locally. Nothing is held hostage.

This isn't a privacy policy — it's an architecture decision. The server *can't* store your data because it was never designed to. See [Guiding Principles — The User Owns Everything](docs/GUIDING_PRINCIPLES.md#1-the-user-owns-everything).

### The Right Model for the Right Job

Most AI tools force you to pick a model. DotBot picks it for you — automatically, per task, from multiple providers running simultaneously.

| Role | Model | When It's Used |
|------|-------|----------------|
| **Workhorse** | DeepSeek V3.2 | 98% of tasks — fast, cheap, very capable |
| **Deep Context** | Gemini 3 Pro (1M tokens) | Massive files, video, PDFs, entire codebases |
| **Architect** | Claude Opus 4.6 | Complex system design, planning, second opinions |
| **Local** | Qwen 2.5 0.5B | Offline fallback — works without internet |

The system examines each request — estimated tokens, file types, task complexity, connectivity — and routes to the best model. If a provider is down, a fallback chain kicks in automatically. You never configure temperature, manage token budgets, or worry about outages. Different tasks get different strengths.

This isn't provider-agnostic — it's provider-*optimal*. See [Coding Patterns — Task-Based Model Selection](docs/CODING_PATTERNS.md#task-based-model-selection).

### Security by Architecture, Not by Prompts

DotBot doesn't rely on prompt guardrails to protect your API keys. It uses **architectural isolation** — the machine boundary between server and local agent is the security boundary.

**API keys are invisible to the LLM.** Keys live in the server's `process.env` and are used only in HTTP Authorization headers. They never appear in prompts, tool results, or WebSocket messages. The LLM cannot leak what it never sees.

**Tool execution happens on your machine.** Even if a prompt injection tricks the LLM into running `echo $OPENAI_API_KEY`, that command executes on the local agent — which doesn't have the server's keys.

**Third-party credentials use split-knowledge encryption.** When you give DotBot a credential (like a Discord bot token), it's encrypted with AES-256-GCM on the server and stored as an opaque blob on your machine. The decryption key lives only on the server. The blob lives only on your machine. **Neither side alone can access the plaintext.** Every credential is cryptographically bound to its allowed API domain via HKDF key derivation — even a compromised LLM trying to proxy your Discord token to `attacker.com` fails because the wrong domain produces the wrong decryption key.

**Chat channels are untrusted inputs.** DotBot's Discord integration treats the chat channel the same way a web app treats HTTP requests — with authentication, authorization, and confirmation:
- Only messages from the verified Discord user ID are processed
- Prompts from Discord carry a `source: "discord"` tag with reduced permissions
- Destructive operations require explicit user confirmation

See [Guiding Principles — Why Can't Prompt Injection Leak API Keys?](docs/GUIDING_PRINCIPLES.md#why-cant-prompt-injection-leak-api-keys) and [Coding Patterns — API Key Isolation](docs/CODING_PATTERNS.md#api-key-isolation-security-by-architecture).

### Persistent Memory That Grows

Stateless AI assistants forget everything between sessions. DotBot doesn't.

- **Mental models** — structured knowledge about people, projects, preferences, and places that persists forever
- **Conversation threads** — organized by topic, not by session. Context carries across days and weeks.
- **Sleep cycle** — a background process that distills raw conversations into structured knowledge every 30 minutes. Over time, DotBot knows who Billy is, what your tech stack is, and how you like your code formatted — without being told twice.
- **Deep memory** — inactive knowledge is archived, not deleted. It's automatically promoted back when relevant again.
- **Knowledge bases** — structured JSON documents ingested from URLs, PDFs, images, video, and audio. Per-persona or shared across all personas.

### Specialized Personas, Not One God Agent

Different tasks need different thinking. A code review requires different expertise than writing marketing copy or debugging a Docker container.

DotBot uses **specialized personas** — each with a focused system prompt, curated tool access, and the right model tier. A receptionist classifies and routes. Workers execute. Councils optionally review. The result: better output from smaller, sharper prompts.

Built-in personas include developers (junior + senior), a researcher, writer, comedian, sysadmin, data analyst, code reviewer, GUI operator, tool maker, and more. You can create your own by dropping a `.md` file — no code changes needed.

### 42+ Tools That Actually Work

Purpose-built tools — each doing one thing reliably — replace fragile shell commands. `create_file(path, content)` beats `echo '...' > file.txt` every time. Deterministic parameters, explicit errors, no quoting bugs.

Categories include filesystem, shell (PowerShell/Bash/Python/Node), HTTP, browser automation, desktop GUI automation, Discord, email, search, reminders, knowledge management, and more. See [Coding Patterns — Many Specific Tools](docs/CODING_PATTERNS.md#many-specific-tools-not-few-general-ones).

### It Keeps Working While You Keep Talking

Action requests spawn **background agent tasks**. You get an immediate acknowledgment and can send corrections, ask questions, or start new work while the agent runs. Progress streams live. A stuck-detection system automatically escalates if an agent spins its wheels.

### It Gets Smarter Every Day

DotBot **learns skills** from your workflows, **discovers and saves new API tools** at runtime, and **grows knowledge bases** from any source. The system's capabilities expand based on what you actually need — not what shipped in the last release.

Skills are instruction sets (`.md` files), not compiled code. They compose with tools, auto-match to relevant tasks, and can be created by you or by DotBot itself.

### It's Endlessly Extensible

Drop a `.md` file in `~/.bot/personas/` and you have a new persona. Drop a skill file and you have a new capability. Add a knowledge doc and a persona gains domain expertise. No config changes, no redeploys, no code modifications. Remove the file and it's gone.

### Talk to It From Anywhere

DotBot integrates with **Discord** as a first-class remote interface. Talk to it from your phone, queue messages while offline, and get updates in dedicated channels. Rich messages with embeds, buttons, and file uploads. The local agent connects to Discord directly — no server relay needed.

---

## Quick Start

DotBot has two components: a **server** (runs on Linux, handles LLM orchestration) and a **local agent** (runs on the user's Windows PC, executes tools). They connect over WebSocket with device-level authentication.

### Install — One Command

The installer asks what you want to install (client, server, or both), and walks you through everything.

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/Druidia-Bot/DotBot/main/install.ps1 | iex
```

**Linux / macOS:**
```bash
curl -fsSL https://raw.githubusercontent.com/Druidia-Bot/DotBot/main/install.sh -o /tmp/install.sh && sed -i 's/\r$//' /tmp/install.sh && bash /tmp/install.sh
```

The installer will:
1. Ask if you want **DotBot Service** *(coming soon)*, **Local Agent**, **Server**, or **Both**
2. Install prerequisites (Node.js, Git, Caddy for server)
3. Clone the repo to `C:\Program Files\.bot` (Windows) or `/opt/.bot` (Linux)
4. Prompt for API keys (all skippable — you need at least one LLM key)
5. Build and configure everything
6. For server installs: set up systemd + Caddy + firewall + auto-HTTPS

> **DotBot Service** is our upcoming hosted server — connect your local agent without running your own server. Coming soon.

### After Install

**Server** — on first start, an invite token is generated:
```bash
journalctl -u dotbot -n 30
# Look for: 🔑 Invite Token Generated — dbot-XXXX-XXXX-XXXX-XXXX
```
Give this token to the person installing the client. Single-use, expires in 7 days. See [deploy/DEPLOY-CHECKLIST.md](deploy/DEPLOY-CHECKLIST.md) for the full guide.

**Client** — on first connect, the agent presents the invite token, registers with the server, and receives permanent device credentials stored in `~/.bot/device.json`. The token is consumed automatically.

**Run / Stop / Update (Windows):**
```powershell
.\run.ps1                # Start server + agent + browser client
.\run.ps1 -Server        # Server only
.\run.ps1 -Agent         # Agent only
.\run.ps1 -Stop          # Stop everything
.\run.ps1 -Update        # Pull latest + rebuild + run
```

**Update (Linux server):**
```bash
sudo /opt/.bot/deploy/update.sh
```

### Device Authentication

DotBot uses **hardware-bound device credentials** instead of API keys:

1. **First connect**: Agent presents invite token → server issues `deviceId` + `deviceSecret`
2. **Every connect**: Agent sends credentials + SHA-256 hardware fingerprint (5 signals: motherboard, CPU, disk, machine GUID, BIOS)
3. **Fingerprint mismatch**: Device immediately revoked, admin alerted via Discord
4. **Rate limiting**: 3 failed auth attempts per IP in 15 minutes → blocked

Admin operations (token management, device listing/revocation) are available only over the authenticated WebSocket connection to admin devices — no HTTP admin endpoints exist.

---

## Architecture

```
┌──────────────────────────────────────────────┐
│              Your Machine                    │
│                                              │
│  ~/.bot/                                     │
│  ├── personas/    ← your custom personas     │
│  │   └── {slug}/knowledge/ ← per-persona KB  │
│  ├── knowledge/   ← general knowledge base   │
│  ├── councils/    ← your custom councils     │
│  ├── skills/      ← learned automations      │
│  └── memory/      ← threads, mental models   │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │         DotBot Local Agent             │  │
│  │  • Executes PowerShell / commands      │  │
│  │  • Reads/writes local files            │  │
│  │  • Manages ~/.bot/ storage             │  │
│  │  • Bootstraps personas & councils      │  │
│  └────────────────────┬───────────────────┘  │
└───────────────────────┼──────────────────────┘
                        │ WebSocket
┌───────────────────────▼──────────────────────┐
│            DotBot Cloud Server               │
│                                              │
│  ┌─── Intake ─────────────────────────────┐  │
│  │  Receptionist → classifies & routes    │  │
│  │  Planner → breaks down complex tasks   │  │
│  │  Chairman → synthesizes multi-step     │  │
│  │  Updater → writes back to memory       │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  ┌─── Workers ────────────────────────────┐  │
│  │  junior-dev  • writer  • researcher    │  │
│  │  senior-dev  • code-reviewer • scribe  │  │
│  │  comedian  • sysadmin  • data-analyst  │  │
│  │  general  • core-dev                   │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  ┌─── Councils (optional) ────────────────┐  │
│  │  User-defined review layers loaded     │  │
│  │  from ~/.bot/councils/                 │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  ┌─── Model Selection ────────────────────┐  │
│  │  Workhorse:    DeepSeek V3.2 (98%)     │  │
│  │  Deep Context: Gemini 3 Pro (1M ctx)   │  │
│  │  Architect:    Claude Opus 4.6         │  │
│  │  Local:        Qwen 2.5 0.5B (offline) │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  State: ZERO. Processes requests & forgets. │
└──────────────────────────────────────────────┘
```

---

## Documentation

### Core

| Document | Description |
|----------|-------------|
| [Guiding Principles](docs/GUIDING_PRINCIPLES.md) | Product philosophy — data ownership, security model, persona architecture, memory system, model selection, self-improvement, and design decisions |
| [Coding Patterns](docs/CODING_PATTERNS.md) | Engineering decisions — tool design, native function calling, separation of concerns, credential security, model selection, flat files over databases |
| [Deploy Checklist](deploy/DEPLOY-CHECKLIST.md) | Full step-by-step server deployment guide |

---

## Configuration

### Server API Key Checklist

DotBot uses **4 model roles** that auto-select per task. You need API keys for the providers you want to use.

| | Provider | Model Role | What It Does | Required? |
|---|----------|-----------|--------------|-----------|
| ☐ | **DeepSeek** | Workhorse | 98% of tasks — chat, tool calls, writing | **Yes** (recommended default) |
| ☐ | **Google Gemini** | Deep Context | 1M token context — large files, video, PDFs | Recommended |
| ☐ | **Anthropic** | Architect | Complex reasoning, planning, design decisions | Recommended |
| ☐ | **OpenAI** | Fallback | Optional fallback if other providers are down | Optional |
| ☐ | **ScrapingDog** | Premium Tools | 39 APIs — Google Search, Amazon, YouTube, etc. | Optional |

**Minimum to start**: One LLM key (DeepSeek is cheapest). The server will start with just one provider — missing providers are skipped, and the available ones handle all roles.

**Get your keys**:
- DeepSeek: https://platform.deepseek.com/api_keys
- Gemini: https://aistudio.google.com/apikey
- Anthropic: https://console.anthropic.com/settings/keys
- OpenAI: https://platform.openai.com/api-keys
- ScrapingDog: https://www.scrapingdog.com/ (premium web scraping, optional)

### Server .env (project root)

```bash
# ============================================================
# DotBot Server — Environment Variables
# ============================================================

# --- Server Ports ---
PORT=3000                        # HTTP API port
WS_PORT=3001                     # WebSocket port
# (If using Caddy, these stay internal — don't expose directly)

# --- LLM Providers (at least ONE required) ---
DEEPSEEK_API_KEY=                # Workhorse — 98% of tasks (recommended default)
ANTHROPIC_API_KEY=               # Architect — complex reasoning, planning
GEMINI_API_KEY=                  # Deep Context — 1M tokens (video, PDFs, huge files)
# OPENAI_API_KEY=                # Optional fallback

# --- Premium Tools (optional) ---
# SCRAPING_DOG_API_KEY=          # ScrapingDog — 39 APIs (Google Search, Amazon, YouTube, etc.)

# --- Advanced (usually leave defaults) ---
# DB_DIR=/home/dotbot/.bot/server-data   # SQLite database location
# LOG_DIR=/home/dotbot/.bot/server-logs  # Server log files
```

### Local Agent .env (~/.bot/.env)

```bash
# ============================================================
# DotBot Local Agent — Environment Variables
# ============================================================

# --- Connection (required) ---
DOTBOT_SERVER=wss://your-server/ws     # Server WebSocket URL (through Caddy reverse proxy)
DOTBOT_INVITE_TOKEN=dbot-XXXX-...      # Invite token (consumed on first connect, auto-removed)

# --- Identity (optional) ---
DEVICE_NAME=My-PC                      # Display name — defaults to hostname

# --- Heartbeat (optional) ---
# HEARTBEAT_ENABLED=true               # Enable periodic awareness checks (default: true)
# HEARTBEAT_INTERVAL_MIN=5             # Minutes between heartbeats (default: 5)
# HEARTBEAT_ACTIVE_START=08:00         # Active hours start (default: always active)
# HEARTBEAT_ACTIVE_END=22:00           # Active hours end

# --- Discord (written automatically by discord.full_setup) ---
# DISCORD_BOT_TOKEN_REF=DISCORD_BOT_TOKEN
# DISCORD_GUILD_ID=...
# DISCORD_CONVERSATION_CHANNEL_ID=...
# DISCORD_UPDATES_CHANNEL_ID=...
# DISCORD_LOGS_CHANNEL_ID=...
```

---

## License

Copyright 2025 Audience AI

Licensed under the [Sustainable Use License](LICENSE.md).

You can use, copy, modify, and redistribute this software for your own internal business purposes, personal use, or non-commercial purposes. You **cannot** offer it as a hosted/managed service to third parties. Self-hosting for your own use is always permitted.

See [LICENSE.md](LICENSE.md) for the complete terms.
