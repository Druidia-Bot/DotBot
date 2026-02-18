# Dot

> She remembers. She learns. She runs on your machine. And she costs pennies.

---

## What We're Building

| Principle            | Why It Matters                                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Affordable**       | Most AI agents burn through API credits. Dot routes 98% of work through the cheapest capable model and only escalates when the task demands it. Real utility shouldn't require a corporate budget. |
| **Accurate**         | More tools, fewer hallucinations. 179 purpose-built tools mean the model doesn't have to guess shell syntax or invent API calls. Structured execution beats hope.                                  |
| **You Own the Data** | Your conversations, memory, skils, personas, and knowledge live on your machine as flat files. The server is a stateless processing layer — it can't leak what it doesn't store.                   |
| **Headless**         | No UI is the UI. The server is the agent. Connect from Windows, Discord, a browser, a CLI, or something you build yourself. Dot doesn't care how you talk to her.                                  |
| **Just Works**       | One install script. One invite link. No YAML pipelines, no Docker compose files, no prompt engineering. Tell her what you need in plain language and she figures out the rest.                     |

---

## What Makes Dot Different?

### 1. Self-Correcting Execution

Most agents run a plan and hand you the result. If step 3 failed silently, you find out when the whole thing breaks.

Dot doesn't work that way. Every plan is a living document. After each step, the plan rewrites itself based on what actually happened — steps get added, removed, or modified mid-flight. An independent critique agent validates each step's output against success criteria, reading files, inspecting images, and verifying deliverables. When something fails, recovery steps are injected automatically.

**Why this matters:** You stop babysitting. The gap between "what I asked for" and "what I got" shrinks dramatically because the system catches its own mistakes before you ever see them.

### 2. Multi-Model Orchestration

This isn't "pick your LLM." This is an orchestra.

One task might touch four different providers. Grok classifies your request in milliseconds. DeepSeek handles the heavy lifting for pennies. Claude Opus steps in for architectural decisions that require deep reasoning. Gemini processes your million-line codebase or 90-minute video. Each model plays the role it's best at — automatically, invisibly.

**Why this matters:** You get the right brain for every phase of every task without managing models, tokens, or provider dashboards. And when a provider goes down, fallback chains kick in. You never notice.

### 3. A Mind, Not a Chat Log

Dot doesn't have conversation history. She has a mind.

Mental models — structured understanding of people, projects, places, and preferences — persist and grow over time. She knows who Billy is, what your tech stack looks like, and how you prefer your code formatted. Not because you told her in this session, but because she learned it over weeks of working with you.

During sleep cycles, raw conversations are automatically condensed into lasting understanding. Stale context gets archived. Key insights get promoted to permanent memory. She maintains her own knowledge without you managing it.

And it's portable. Your entire relationship with Dot lives in `~/.bot/` — copy it to a new machine and pick up exactly where you left off. No cloud account, no sync service, no vendor lock-in. It's just files.

**Why this matters:** Talking to Dot feels natural because she already knows the context. No re-explaining your project structure, no hunting through old chat windows, no starting from scratch every session. The longer you use her, the less you have to say. And because it's all flat files, you can back it up with git — giving you versioned history of her entire mind that you can diff, branch, or roll back.

### 4. Headless Agent Runtime

Dot has no native interface — and that's the point.

The server _is_ the agent. Today there's a Windows client and a light browser UI. Tomorrow there could be a Linux CLI, a mobile app, a Slack bot, or a custom dashboard. All connect as equal citizens over WebSocket. Build your own interface if the existing ones don't fit. Right now we recommend Discord — it gives you a polished chat UI for free and lets you talk to Dot from anywhere, on any device. Messages route through your Windows client, not the server directly, so your machine stays in the loop.

**Why this matters:** You're not locked into someone else's vision of what an AI assistant looks like. The intelligence layer is decoupled from the presentation layer. Dot is infrastructure, not an app.

---

## Why Dot Is (Dare We Say) Better

### Natural Conversation Threading

Talk to Dot the way you talk to a person.

> "Can you refactor the auth module to use JWT? Oh and remind me to call Mom at 6pm. Actually for the auth refactor, make sure it's compatible with our existing session middleware."

Three tasks. Two topics. One callback to an earlier request. Most AI tools either blend everything into confused soup, force you to submit one request at a time, or silently drop the third part.

Dot parses natural language into discrete tasks, routes each to a specialized agent, maintains isolated context per task, and understands that "for the auth refactor" reconnects to the first request — not the reminder. One conversation thread, unlimited parallel topics, zero cognitive overhead.

### Mid-Flight Course Correction

You don't have to wait for Dot to finish before telling her she's going the wrong direction.

Send corrections while an agent is working. They queue up and get incorporated at the next step boundary through automatic replanning. The plan adapts to your feedback in real time.

### Dead Agent Recovery

If an agent crashes mid-task, Dot detects it via heartbeat, marks it failed, and when work resumes, a successor agent gets a full handoff brief — completed steps, in-progress tool calls, remaining work. No lost context. No starting over.

### Autonomous Scheduled Execution

"Every morning at 9am, check my stocks and summarize." Dot does it — unattended, through the full pipeline. Cron-based recurring tasks with routing, persona selection, planning, and execution. She works while you sleep.

### Heartbeat Awareness

Dot wakes up every few minutes, evaluates if anything needs her attention, and only surfaces urgent items. Idle-gated with exponential backoff so she doesn't burn cycles or money when nothing's happening.

### Zero-Trust Credential Security

Credentials never enter the LLM's context — architecturally impossible, not just policy. The server holds the master key, your machine holds encrypted blobs, and decryption is domain-scoped. A token encrypted for `github.com` literally cannot be decrypted for `attacker.com`. Even a successful prompt injection can't exfiltrate secrets because tool commands execute on your machine, not the server.

### 179 Tools, Not Plugins

Filesystem, shell, browser automation, GUI vision, git, HTTP, PDF, databases, package managers, audio, monitoring — built-in and platform-aware. Not a marketplace. Not plugins you install and pray work. Purpose-built tools that execute reliably because the model doesn't have to guess syntax or wrestle with shell escaping.

### Persona-Based Routing

Incoming requests are classified and routed to specialized personas with curated tool sets and custom system prompts. Each agent gets a dynamically written prompt tailored to the specific task, with only the 30-50 relevant tools loaded — not all 174. Right context, right tools, right model.

### Research Continuity

Agents work in isolated workspaces retained for 24 hours. A follow-up task discovers and builds on previous research. Work compounds across sessions — Dot doesn't re-Google what she already found this morning.

### Knowledge Ingestion

Upload PDFs, images, archives. They're processed through million-token context, structured into searchable knowledge, and optionaly scoped to specific personas. Dot reads your docs so she can reference them when it matters. Just say "Dot add this to your knowledgebase."

### Specialized Knowledge Ingestion

You can also create specialized personas with domain-specific knowledge — a legal assistant trained on your contracts, a support agent that knows your product documentation, or a researcher versed in your company's internal processes. Each persona maintains its own knowledge scope and tool set.

### Multi-Tenant Architecture

One server supports multiple users, each with their own local agent, memory, credentials, and workspaces. Deploy for a team or a company — the architecture separates intelligence (cloud) from data (each user's machine).

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

**Minimum to start:** One LLM API key. xAI offers the best value — [get one here](https://console.x.ai/). DeepSeek is the cheapest fallback — [get one here](https://platform.deepseek.com/api_keys).

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
>
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

Once installed, DotBot runs as a **background service** that starts automatically on login. A small system tray icon appears so you know it's running — right-click it for status, Open UI, or Shutdown.

- **Start Menu** — search "DotBot" to launch (runs invisibly with a tray icon)
- **Browser** — open the web UI via the tray icon or `.\run.ps1 -Open`
- **Discord** — ask DotBot: _"set up Discord"_ to connect your Discord server

**Managing DotBot on Windows:**

```powershell
# From the install directory (default: C:\.bot):
.\run.ps1                # Start agent + server (dev) with visible console
.\run.ps1 -Stop          # Stop all DotBot processes
.\run.ps1 -Update        # Pull latest code + rebuild + restart
.\run.ps1 -Status        # Check what's running
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

## Uninstalling

### Uninstalling the Agent (Windows PC)

```powershell
# From the install directory (default: C:\.bot):
.\uninstall.ps1                # Interactive — confirms each step
.\uninstall.ps1 -Force         # Remove everything without prompting
.\uninstall.ps1 -KeepData      # Remove app but keep ~/.bot/ (memory, credentials, settings)
.\uninstall.ps1 -WhatIf        # Dry run — show what would be removed
```

This removes: running processes, scheduled task, Start Menu shortcut, CLI wrapper, user PATH entry, install directory, user data (`~/.bot/`), and Playwright browsers. Git, Node.js, Python, Everything Search, and Tesseract are **not** removed (uninstall them separately via Settings > Apps if desired).

### Uninstalling the Server (Linux)

```bash
sudo bash uninstall.sh              # Interactive
sudo bash uninstall.sh --force      # No prompts
sudo bash uninstall.sh --keep-data  # Preserve /home/dotbot/.bot/
sudo bash uninstall.sh --dry-run    # Show what would be removed
```

This removes: systemd service, Caddy DotBot config, deploy directory (`/opt/.bot`), `dotbot` system user, logrotate config, and access logs. Node.js, Caddy, and UFW rules are **not** removed.

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
cd "C:\.bot"
git pull
npm install -w shared -w local-agent
npm run build -w shared -w local-agent
```

### Agent Crashes on Startup

- **Check logs:** `Get-Content "$env:USERPROFILE\.bot\agent.log" -Tail 50`
- **Auto-rollback:** If the agent crashes within 10 seconds of an update, the launcher restores the previous build automatically
- **Manual rollback:** Copy `~/.bot/workspace/dist-backup/` back to `local-agent/dist/`
- **Nuclear option:** Delete the install directory, re-run the installer with a new invite token

### Customizing Default Skills

DotBot ships with built-in skills in `~/.bot/skills/`. On startup, the agent checks each skill's `.version` file against the source version — if the source is newer, it **overwrites** the installed `SKILL.md`.

**If you've customized a default skill and want to keep your changes**, set its version file to a high number so updates never overwrite it:

```powershell
# Example: protect your customized run-log-diagnostics skill
Set-Content "$env:USERPROFILE\.bot\skills\run-log-diagnostics\.version" "99"
```

```bash
# Linux/Mac
echo 99 > ~/.bot/skills/run-log-diagnostics/.version
```

This tells the bootstrap "version 99 is installed" — since source versions are always lower, your file won't be touched. To receive upstream updates again, delete the `.version` file or set it back to `0`.

### Discord Not Responding

- **Check connection:** Look for `[Discord] Bot online` in the agent console
- **Re-setup:** Tell DotBot _"set up Discord"_ — it walks you through the full configuration
- **Token expired:** Discord bot tokens don't expire, but if the bot was removed from the server, re-invite it

---

## API Keys

DotBot is **BYOK (Bring Your Own Keys)**. Every model role has a fallback chain — the system picks the best available provider from your keys. More keys = better results, but one key is enough to start.

| Provider          | What It Powers                                                    | Required?                     |
| ----------------- | ----------------------------------------------------------------- | ----------------------------- |
| **xAI**           | Primary workhorse, intake classification, conversational assistant | **Recommended** (best value)  |
| **DeepSeek**      | Workhorse fallback, reasoning tasks                               | **Recommended** (cheapest)    |
| **Google Gemini** | 1M token context (large files, video, PDFs), image generation     | Recommended                   |
| **Anthropic**     | Complex reasoning, planning, architectural decisions              | Recommended                   |
| **OpenAI**        | Fallback for multiple roles, image generation fallback            | Optional                      |
| **ScrapingDog**   | 42 premium APIs — Google Search, Amazon, YouTube, LinkedIn, etc.  | Optional                      |

**Minimum to start**: One LLM key. The server auto-assigns all roles to whatever providers you have — missing providers are skipped, and fallback chains fill the gaps.

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
XAI_API_KEY=                     # Primary — workhorse, intake, assistant (recommended)
DEEPSEEK_API_KEY=                # Fallback workhorse — cheapest option
GEMINI_API_KEY=                  # Deep context (1M tokens), image generation
ANTHROPIC_API_KEY=               # Architect — complex reasoning, planning
# OPENAI_API_KEY=                # Optional fallback for multiple roles

# --- Premium Tools (optional) ---
# SCRAPING_DOG_API_KEY=          # ScrapingDog — 42 APIs (Google Search, Amazon, YouTube, etc.)

# --- Security (IMPORTANT for production) ---
ADMIN_API_KEY=                   # Required for production self-hosting
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

## The Endgame

The ultimate goal isn't to build the best AI assistant. It's to build an AI assistant that builds itself.

Dot already updates herself when you ask. She already writes code, runs tests, and understands her own architecture. The roadmap is straightforward: give her the ability to review her own issues, plan her own features, write her own pull requests, and merge her own improvements — with human approval as a guardrail, not a bottleneck.

An open-source codebase maintained by the agent it powers. Contributors submit issues and ideas. Dot triages them, writes the implementation, validates it against her own test suite, and opens the PR. A human reviews and merges. The cycle repeats.

This isn't science fiction. Every piece of the pipeline already exists in isolation — planning, code generation, self-testing, git operations, PR creation. The work is connecting them into a self-improving loop with the right safety rails.

When that happens, Dot stops being a project you maintain and becomes a project that maintains itself.

---

## License

Copyright 2025 Audience AI

Licensed under the [Sustainable Use License](LICENSE.md).

You can use, copy, modify, and redistribute this software for your own internal business purposes, personal use, or non-commercial purposes. You **cannot** offer it as a hosted/managed service to third parties. Self-hosting for your own use is always permitted.

See [LICENSE.md](LICENSE.md) for the complete terms.
