---
name: codex-setup
description: Installs OpenAI Codex CLI (OpenAI's AI coding agent) and walks the user through authentication. Auto-downloads via npm and opens the auth flow.
tags: [codex, openai, setup, install, codegen, authentication]
disable-model-invocation: true
user-invocable: true
allowed-tools: [runtime.check, runtime.install, shell.powershell, codegen.status]
---

# Codex CLI Setup — AI Coding Agent

This skill installs OpenAI Codex CLI and guides the user through authentication. Codex CLI lets DotBot delegate complex coding tasks to a specialized agent.

**EXECUTION MODEL: This is an autonomous skill. Do NOT stop to wait for user confirmation between steps. Execute each tool in sequence. The only pause is when the user is authenticating in the terminal window.**

## Execution Flow

```
1. runtime.check({ name: "codex" })
   ├─ Installed → skip to step 3 (auth check)
   └─ Not installed → continue to step 2
2. runtime.install({ name: "codex" })
   ├─ Success → continue to step 3
   └─ Failure → show manual install instructions and STOP
3. Open Codex CLI in a visible terminal for authentication
4. Tell user to authenticate and then close the window
```

**Do NOT output a plan and stop. Execute the tools.**

---

## Step 1: Check if Codex CLI is Installed

```
runtime.check({ name: "codex" })
```

- **If available**: Skip to Step 3.
- **If not available**: Continue to Step 2.

---

## Step 2: Install Codex CLI

```
runtime.install({ name: "codex" })
```

This runs `npm install -g @openai/codex`. It may take 1-2 minutes.

- **If success**: Continue to Step 3.
- **If failure** (npm not found, permission error, etc.): Tell the user:

> Codex CLI couldn't be auto-installed. You can install it manually:
>
> ```
> npm install -g @openai/codex
> ```
>
> If npm isn't available, install Node.js first: https://nodejs.org
>
> After installing, let me know and I'll continue the setup.

**STOP here if install fails. Do not proceed.**

---

## Step 3: Open Codex CLI for Authentication

Run this to open Codex CLI in a visible terminal window:

```
shell.powershell({ script: "Start-Process cmd -ArgumentList '/k', 'codex'" })
```

This opens a new Command Prompt window running `codex`. On first run, Codex CLI will:
1. Prompt for authentication with OpenAI
2. Open a browser window for sign-in
3. Wait for the user to authorize

**Immediately after running the command**, tell the user:

> I've opened Codex CLI in a new terminal window. Here's what to do:
>
> 1. **Follow the prompts in the terminal** — it will guide you through authentication
> 2. **A browser window should open** — sign in with your OpenAI account
> 3. **Authorize Codex CLI** when prompted
> 4. Once you see a success message in the terminal, **you can close the terminal window**
>
> After that, Codex CLI is ready! I'll be able to use it for complex coding tasks like building projects, refactoring code, and running multi-file edits.

---

## Step 4: Verify (Optional)

If the user says they're done or asks to verify:

```
codegen.status()
```

- **If Codex shows as available**: Tell the user setup is complete.
- **If not available**: May need a restart. Tell the user to restart the agent.

---

## Troubleshooting

### npm not found
Node.js needs to be installed first. Tell the user:
> Node.js is required for Codex CLI. Install it from https://nodejs.org (LTS version recommended), then restart and try again.

### Permission errors during install
On Windows, npm global installs sometimes need admin rights. Tell the user:
> Try running this in an **administrator** terminal:
> ```
> npm install -g @openai/codex
> ```

### Auth didn't work / browser didn't open
Tell the user:
> Look in the terminal window for instructions or a URL. Copy and paste any URL into your browser manually to complete authentication.

### User doesn't have an OpenAI account
> You'll need an OpenAI account with API access to use Codex CLI. Sign up at https://platform.openai.com — you'll need to add a payment method for API usage.
