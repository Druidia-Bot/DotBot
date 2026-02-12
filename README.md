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
| **Intake** | xAI Grok 4.1 Fast | Request classification & routing — lowest latency first response |
| **Workhorse** | DeepSeek V3.2 | 98% of execution — fast, cheap, very capable |
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

DotBot uses **specialized personas** — each with a focused system prompt, curated tool access, and the right model tier. A receptionist classifies and routes. A persona writer generates custom system prompts per task. An orchestrator spawns isolated agents. Workers execute. A judge evaluates quality. The result: better output from smaller, sharper prompts.

15 built-in personas include developers (junior, senior, core), researcher, writer, scribe, comedian, sysadmin, data analyst, code reviewer, GUI operator, tool maker, personal assistant, oracle, and a general-purpose fallback. You can create your own by dropping a `.md` file — no code changes needed.

### 130+ Tools That Actually Work

Purpose-built tools — each doing one thing reliably — replace fragile shell commands. `create_file(path, content)` beats `echo '...' > file.txt` every time. Deterministic parameters, explicit errors, no quoting bugs.

Categories include filesystem, shell (PowerShell/Bash/Python/Node), HTTP, browser automation, desktop GUI automation, Discord, email, search, reminders, runtime management, knowledge management, and more. See [Coding Patterns — Many Specific Tools](docs/CODING_PATTERNS.md#many-specific-tools-not-few-general-ones).

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

## Getting Started

DotBot is a two-part system: a **cloud server** (handles AI reasoning) and a **local agent** (runs on your Windows PC). You install the server first, then use an invite link to connect agents.

### Step 1 — Install the Server

SSH into a Linux server (Ubuntu/Debian recommended) with a domain name pointed at it, and run:

```bash
curl -fsSL https://raw.githubusercontent.com/Druidia-Bot/DotBot/main/install.sh -o /tmp/install.sh && sed -i 's/\r$//' /tmp/install.sh && bash /tmp/install.sh
```

The installer will:
1. Install Node.js, Caddy (automatic HTTPS), and build tools
2. Ask for your domain name
3. Ask for your API keys (at least one — see [API Key Checklist](#server-api-key-checklist))
4. Build and start the server with auto-restarts
5. **Print an invite URL** — this is how you connect agents

> **Minimum to start:** One AI API key. DeepSeek is cheapest — [get one here](https://platform.deepseek.com/api_keys). The server works with a single provider and falls back gracefully.

### Step 2 — Get an Invite Link

The server installer prints an **invite URL** at the end:
```
https://your-server.com/invite/dbot-XXXX-XXXX-XXXX-XXXX
```

This is a **single-use link** that expires in 7 days. Open it in a browser to see a branded page with the install command, or share it directly with the person who needs to connect.

**Need more invite links?**
```bash
# On the server:
cd /opt/.bot && sudo -u dotbot node server/dist/generate-invite.js

# With options:
node server/dist/generate-invite.js --label "For Alice" --expiry-days 14 --max-uses 3
```

You can also generate tokens via WebSocket from an admin device (`create_token` action).

### Step 3 — Install the Agent on a Windows PC

Open the invite link in a browser. You'll see a page with a one-liner — copy it, paste it into **PowerShell as Administrator**, and press Enter:

```powershell
irm 'https://your-server.com/invite/dbot-XXXX-.../install' | iex
```

The installer handles everything: Git, Node.js, dependencies, configuration. Takes 2–5 minutes. The invite token is consumed on first connect — the link stops working after that.

**Alternative (manual):** If you have the server URL and token separately:
```powershell
irm https://raw.githubusercontent.com/Druidia-Bot/DotBot/main/install.ps1 | iex
```
Enter the server URL and invite token when prompted.

### Step 4 — Use It

Once installed, DotBot runs as a **background service** that starts automatically on login. You can also launch it manually:

- **Start Menu** — search "DotBot" to launch with a visible console
- **Browser** — open `client/index.html` from the install directory for the web UI
- **Discord** — ask DotBot: *"set up Discord"* to connect your Discord server

**Managing DotBot on Windows:**
```powershell
# From the install directory (default: C:\Program Files\.bot):
.\run.ps1                # Start agent + server (dev) or agent-only (production)
.\run.ps1 -Stop          # Stop all DotBot processes
.\run.ps1 -Update        # Pull latest code + rebuild + restart
```

**Managing the Linux server:**
```bash
systemctl status dotbot                                       # Check status
systemctl restart dotbot                                      # Restart
journalctl -u dotbot -f                                       # Live logs
bash /opt/.bot/deploy/update.sh                               # Update server
cd /opt/.bot && sudo -u dotbot node server/dist/generate-invite.js  # New invite
```

---

### Dev Setup (Both on One Machine)

> For development and testing only. Runs the server and agent on the same machine.

```bash
git clone https://github.com/Druidia-Bot/DotBot.git
cd DotBot
cp .env.example .env         # Edit .env and add your API keys
npm install
```

**Windows:**
```powershell
.\run.ps1                    # Starts server + agent + opens browser client
.\run.ps1 -Stop              # Stop everything
```

**Linux / macOS:**
```bash
bash run-dev.sh              # Starts server + agent
bash run-dev.sh --stop       # Stop everything
```

---

## Updating

DotBot has three update paths depending on how you're running it.

### Updating the Agent (Windows PC)

**Option A — Ask DotBot to update itself:**
Tell DotBot *"update yourself"* via chat or Discord. The agent runs `git pull`, rebuilds, and restarts automatically.

**Option B — Manual update:**
```powershell
# From the install directory:
.\run.ps1 -Update        # Pulls latest code, installs deps, rebuilds, restarts
```

**Option C — Via the Start Menu:**
The DotBot shortcut runs the launcher, which auto-restarts after updates. The agent's built-in update checker polls for new commits periodically.

> **Note:** The agent only installs dependencies for `shared/` and `local-agent/` — it will not attempt to build server components, even on a full monorepo clone.

### Updating the Server (Linux)

```bash
bash /opt/.bot/deploy/update.sh
```

This pulls the latest code, rebuilds, and restarts the systemd service. For manual control:
```bash
cd /opt/.bot
sudo -u dotbot git pull
sudo -u dotbot npm install -w shared -w server
sudo -u dotbot npm run build -w shared -w server
sudo systemctl restart dotbot
```

### What Happens During an Update

1. `git pull` fetches the latest code
2. `npm install` installs new dependencies (scoped to relevant packages only)
3. `npm run build` compiles TypeScript
4. The agent restarts (exit code 42 signals the launcher to restart immediately)
5. On restart, the agent reconnects to the server and re-authenticates

**If an update breaks something:** The launcher (`launch.ps1`) has auto-rollback — if the agent crashes within 10 seconds of starting after an update, it automatically restores the previous build.

---

## Troubleshooting

### Agent Won't Connect

**Symptoms:** `[Agent] Connecting to wss://...` but never authenticates, or connection drops immediately.

- **Check the server is running:** `systemctl status dotbot` on the server
- **Check the URL:** `~/.bot/.env` should have `DOTBOT_SERVER=wss://your-domain/ws` (note the `/ws` suffix for remote servers)
- **Check firewall:** Port 443 must be open on the server (Caddy handles HTTPS)
- **Check Caddy:** `systemctl status caddy` — Caddy reverse-proxies `/ws` to the internal WebSocket port

### Authentication Failed

**`fingerprint_mismatch`** — The hardware fingerprint changed since last connection. This can happen after:
- A code update that changed the fingerprint computation
- A Windows update or BIOS update
- Adding/removing hardware

The server now **accepts the new fingerprint automatically** and logs a warning. If the device was previously revoked (older server versions revoked on mismatch), an admin can un-revoke it:
```bash
# From an admin device, send the unrevoke_device admin action with the device ID
```
Or on the client: delete `~/.bot/device.json` and re-register with a new invite token.

**`device_revoked`** — The device was manually revoked by an admin. Get a new invite token and re-register:
```powershell
Remove-Item "$env:USERPROFILE\.bot\device.json"
# Set the new token in ~/.bot/.env as DOTBOT_INVITE_TOKEN=dbot-XXXX-...
# Then restart the agent
```

**`invalid_credentials`** — The device secret doesn't match. This usually means `~/.bot/device.json` was corrupted or copied from another machine. Delete it and re-register with a new invite token.

**`rate_limited`** — Too many failed auth attempts from this IP. Wait 15 minutes and try again.

### Update Failed on Client-Only PC

**Symptom:** `npm install` or `npm run build` fails with errors about `better-sqlite3` or server packages.

The update process only installs and builds `shared/` and `local-agent/`. If you see server build errors, you may be running an older version of the update tool. Pull the latest code manually:
```powershell
cd "C:\Program Files\.bot"
git pull
npm install -w shared -w local-agent
npm run build -w shared -w local-agent
```

### Agent Crashes on Startup

- **Check logs:** `Get-Content "$env:USERPROFILE\.bot\agent.log" -Tail 50`
- **Auto-rollback:** If the agent crashes within 10 seconds of an update, the launcher restores the previous build automatically
- **Manual rollback:** Copy `~/.bot/workspace/dist-backup/` back to `local-agent/dist/`
- **Nuclear option:** Delete the install directory, re-run the installer with a new invite token

### Discord Not Responding

- **Check connection:** Look for `[Discord] Bot online` in the agent console
- **Re-setup:** Tell DotBot *"set up Discord"* — it walks you through the full configuration
- **Token expired:** Discord bot tokens don't expire, but if the bot was removed from the server, re-invite it

---

## How Authentication Works

DotBot uses **hardware-bound device credentials** — no passwords or API keys to manage:

1. **First connect** — agent presents invite token → server issues permanent device credentials (stored in `~/.bot/device.json`)
2. **Every connect** — agent sends credentials + a hardware fingerprint (motherboard serial, CPU ID, boot disk serial, Windows Machine GUID, BIOS serial)
3. **If the fingerprint changes** (code update, hardware swap, OS reinstall) — the server accepts the new fingerprint, logs a warning, and notifies admin devices. This is a monitoring signal, not a blocker.
4. **If someone copies your credentials to another machine** — admin is alerted via the fingerprint change notification and can manually revoke the device
5. **Brute force protection** — 3 failed attempts in 15 minutes → IP blocked

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
│  ├── skills/      ← learned automations      │
│  ├── memory/      ← threads, mental models   │
│  └── device.json  ← hardware-bound creds     │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │         DotBot Local Agent             │  │
│  │  • 130+ tools (shell, files, browser)  │  │
│  │  • Manages ~/.bot/ storage & memory    │  │
│  │  • Discord integration                 │  │
│  │  • Credential vault (split-knowledge)  │  │
│  └────────────────────┬───────────────────┘  │
└───────────────────────┼──────────────────────┘
                        │ WebSocket (encrypted)
┌───────────────────────▼──────────────────────┐
│            DotBot Cloud Server               │
│                                              │
│  ┌─── V2 Pipeline ───────────────────────┐  │
│  │  Receptionist → classifies & routes   │  │
│  │  Persona Writer → custom prompts/tools│  │
│  │  Orchestrator → spawns isolated agents│  │
│  │  Judge → evaluates quality            │  │
│  │  Reflector → learns skills (async)    │  │
│  │  Updater → writes back to memory      │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  ┌─── Workers (15 personas) ─────────────┐  │
│  │  junior-dev • senior-dev • core-dev   │  │
│  │  researcher • writer • scribe         │  │
│  │  sysadmin • data-analyst • comedian   │  │
│  │  gui-operator • tool-maker            │  │
│  │  personal-assistant • oracle          │  │
│  │  code-reviewer • general              │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  ┌─── Model Selection ────────────────────┐  │
│  │  Intake:       xAI Grok 4.1 Fast      │  │
│  │  Workhorse:    DeepSeek V3.2 (98%)    │  │
│  │  Deep Context: Gemini 3 Pro (1M ctx)  │  │
│  │  Architect:    Claude Opus 4.6        │  │
│  │  Local:        Qwen 2.5 0.5B         │  │
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

DotBot uses **5 model roles** that auto-select per task. You need API keys for the providers you want to use.

| | Provider | Model Role | What It Does | Required? |
|---|----------|-----------|--------------|-----------|
| ☐ | **DeepSeek** | Workhorse | 98% of execution — chat, tool calls, writing | **Yes** (recommended default) |
| ☐ | **xAI** | Intake | Request classification & routing (fast first response) | Recommended |
| ☐ | **Google Gemini** | Deep Context | 1M token context — large files, video, PDFs | Recommended |
| ☐ | **Anthropic** | Architect | Complex reasoning, planning, design decisions | Recommended |
| ☐ | **OpenAI** | Fallback | Optional fallback if other providers are down | Optional |
| ☐ | **ScrapingDog** | Premium Tools | 39 APIs — Google Search, Amazon, YouTube, etc. | Optional |

**Minimum to start**: One LLM key (DeepSeek is cheapest). The server will start with just one provider — missing providers are skipped, and the available ones handle all roles.

**Get your keys**:
- DeepSeek: https://platform.deepseek.com/api_keys
- xAI: https://console.x.ai/ (Grok API keys)
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
DEEPSEEK_API_KEY=                # Workhorse — 98% of execution (recommended default)
XAI_API_KEY=                     # Intake — fast request classification & routing
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
