---
name: claude-code-setup
description: Installs Claude Code (Anthropic's AI coding agent CLI) and walks the user through authentication. Auto-downloads via npm and opens the auth flow.
tags: [claude, code, setup, install, codegen, anthropic, authentication]
disable-model-invocation: true
user-invocable: true
allowed-tools: [runtime.check, runtime.install, shell.powershell, codegen.status]
---

# Claude Code Setup — AI Coding Agent

This skill installs Claude Code (Anthropic's AI coding CLI) and guides the user through authentication. Claude Code lets DotBot delegate complex coding tasks to a specialized agent.

**EXECUTION MODEL: This is an autonomous skill. Do NOT stop to wait for user confirmation between steps. Execute each tool in sequence. The only pause is when the user is authenticating in the terminal window.**

## Execution Flow

```
1. runtime.check({ name: "claude" })
   ├─ Installed → skip to step 3 (auth check)
   └─ Not installed → continue to step 2
2. runtime.install({ name: "claude" })
   ├─ Success → continue to step 3
   └─ Failure → show manual install instructions and STOP
3. Open Claude Code in a visible terminal for authentication
4. Tell user to authenticate and then close the window
```

**Do NOT output a plan and stop. Execute the tools.**

---

## Step 1: Check if Claude Code is Installed

```
runtime.check({ name: "claude" })
```

- **If available**: Skip to Step 3.
- **If not available**: Continue to Step 2.

---

## Step 2: Install Claude Code

```
runtime.install({ name: "claude" })
```

This runs `npm install -g @anthropic-ai/claude-code`. It may take 1-2 minutes.

- **If success**: Continue to Step 3.
- **If failure** (npm not found, permission error, etc.): Tell the user:

> Claude Code couldn't be auto-installed. You can install it manually:
>
> ```
> npm install -g @anthropic-ai/claude-code
> ```
>
> If npm isn't available, install Node.js first: https://nodejs.org
>
> After installing, let me know and I'll continue the setup.

**STOP here if install fails. Do not proceed.**

---

## Step 3: Open Claude Code for Authentication

Run this to open Claude Code in a visible terminal window:

```
shell.powershell({ script: "Start-Process cmd -ArgumentList '/k', 'claude'" })
```

This opens a new Command Prompt window running `claude`. On first run, Claude Code will:
1. Display a URL to authenticate with Anthropic
2. Open the URL in the user's default browser automatically
3. Wait for the user to sign in and authorize

**Immediately after running the command**, tell the user:

> I've opened Claude Code in a new terminal window. Here's what to do:
>
> 1. **A browser window should open automatically** — sign in with your Anthropic account
> 2. If no browser opens, look for a URL in the terminal window and open it manually
> 3. **Authorize Claude Code** when prompted
> 4. Once you see a success message in the terminal, **you can close the terminal window**
>
> After that, Claude Code is ready! I'll be able to use it for complex coding tasks like building projects, refactoring code, and running multi-file edits.

---

## Step 4: Verify (Optional)

If the user says they're done or asks to verify:

```
codegen.status()
```

- **If Claude Code shows as available**: Tell the user setup is complete.
- **If not available**: May need a restart. Tell the user to restart the agent.

---

## Troubleshooting

### npm not found
Node.js needs to be installed first. Tell the user:
> Node.js is required for Claude Code. Install it from https://nodejs.org (LTS version recommended), then restart and try again.

### Permission errors during install
On Windows, npm global installs sometimes need admin rights. Tell the user:
> Try running this in an **administrator** terminal:
> ```
> npm install -g @anthropic-ai/claude-code
> ```

### Auth didn't work / browser didn't open
Tell the user:
> Look in the terminal window for a URL starting with `https://`. Copy and paste it into your browser manually to complete authentication.

### User doesn't have an Anthropic account
> You'll need an Anthropic account to use Claude Code. Sign up at https://console.anthropic.com — you'll need an API key or a Max/Pro subscription.
