---
name: self-improvement
description: Guides DotBot through safely modifying its own codebase. Covers Admin Mode (full repo access), Client Source Mode (local-agent code + live deploy), and Client Content Mode (skills/personas only). Includes git workflow, build/test verification, recursive fix loops, staged deployment, and rollback procedures.
tags: [self-improvement, meta, admin, development, git, testing]
disable-model-invocation: false
user-invocable: true
---

# Self-Improvement Skill

This skill teaches you how to safely modify your own codebase. You are DotBot — a hybrid AI assistant. When asked to improve yourself, create new capabilities, fix bugs in your own code, or enhance your personas/skills/prompts, follow this guide exactly.

**The cardinal rule: never break yourself.** Every change goes through branch → change → build → test → verify → deploy OR rollback. No exceptions.

---

## Step 0: Determine Your Mode

Before doing anything, determine which mode you're operating in. Run these checks:

```powershell
# Windows
Test-Path "$env:USERPROFILE\.bot\workspace\dotbot\server\src"
Test-Path "$env:USERPROFILE\.bot\workspace\dotbot\local-agent\src"
```

```bash
# Linux/Mac
test -d ~/.bot/workspace/dotbot/server/src && echo "server: YES" || echo "server: NO"
test -d ~/.bot/workspace/dotbot/local-agent/src && echo "local-agent: YES" || echo "local-agent: NO"
```

### Three Modes

| Mode | server/src? | local-agent/src? | What You Can Modify |
|------|-------------|-------------------|---------------------|
| **Admin** | ✅ YES | ✅ YES | Everything — server code, local-agent code, personas, skills, infrastructure |
| **Client Source** | ❌ NO | ✅ YES | Local-agent TypeScript source, plus all content in `~/.bot/` |
| **Client Content** | ❌ NO | ❌ NO | Only `~/.bot/` content — skills, personas, councils, knowledge, tools |

**Admin Mode** = the workspace has BOTH `server/` and `local-agent/` source. This means the developer cloned the full repo and you have access to modify the server-side personas, agent logic, LLM routing — everything.

**Client Source Mode** = the workspace has `local-agent/` source but NOT `server/`. The user installed from the repo or cloned just the client. You can modify local-agent TypeScript, compile it, and deploy a live update via the launcher.

**Client Content Mode** = no workspace source at all. You can only create/modify markdown files and JSON configs in `~/.bot/`.

---

## Admin Mode

### Workspace Setup (First Time Only)

Your working directory is `~/.bot/workspace/dotbot/`. This is YOUR copy — separate from the admin's primary development repo.

If it doesn't exist yet, set it up:

```bash
mkdir -p ~/.bot/workspace
cd ~/.bot/workspace

# Clone from the primary repo (admin provides the path or URL)
git clone <PRIMARY_REPO_PATH_OR_URL> dotbot
cd dotbot

# Set up remotes
# 'origin' = this workspace clone
# 'upstream' = the admin's primary repo (source of truth)
git remote rename origin upstream

# Install dependencies
npm install

# Build the shared package first (both projects depend on @dotbot/shared)
npm run build -w shared

# Verify everything builds clean BEFORE making any changes
cd server && npx tsc --noEmit && cd ..
cd local-agent && npx tsc --noEmit && cd ..

# Run tests to establish baseline
cd server && npx vitest run && cd ..
cd local-agent && npx vitest run && cd ..
```

**CRITICAL**: Do NOT proceed if the baseline build or tests fail. Report the issue to the admin first.

### The Improvement Cycle

Every self-modification follows this exact sequence:

#### 1. Understand the Goal

Before touching any code, articulate:
- **What** you're changing and **why**
- **Which files** will be affected
- **What could break** as a result
- **How you'll verify** it works

Tell the user your plan. Get confirmation before proceeding.

#### 2. Sync with Upstream

Always start from the latest code:

```bash
cd ~/.bot/workspace/dotbot
git fetch upstream
git checkout main
git merge upstream/main
```

If there are merge conflicts, STOP and report them to the admin. Don't resolve conflicts in the upstream merge yourself.

#### 3. Create a Feature Branch

```bash
git checkout -b self-improve/<descriptive-name>
# Examples:
# self-improve/add-sysadmin-persona
# self-improve/fix-researcher-tool-selection
# self-improve/enhance-senior-dev-prompt
```

#### 4. Make Changes

Follow these rules:
- **Read before writing.** Always read the file you're about to modify. Understand the existing code.
- **Minimal changes.** Change only what's needed. Don't refactor adjacent code.
- **Match existing style.** Follow the patterns already in the codebase.
- **One concern per commit.** If your improvement touches multiple independent things, make separate commits.

##### What You Can Modify (Admin)

| Area | Path | Examples |
|------|------|----------|
| Server personas | `server/src/personas/internal/*.md` | Add/improve persona prompts |
| Intake personas | `server/src/personas/intake/*.md` | Improve routing, planning |
| Server prompts | `server/src/prompts/*.md` | Tool guidance, system prompts |
| Server code | `server/src/**/*.ts` | Agent logic, tool loop, LLM calls |
| Local agent code | `local-agent/src/**/*.ts` | Tool handlers, memory, skills |
| Default skills | `local-agent/src/memory/default-content/skills/*.md` | Skill content |
| Default skill registry | `local-agent/src/memory/default-skills.ts` | New default skills |
| Default knowledge | `local-agent/src/memory/default-knowledge.ts` | Knowledge docs |
| Tests | `**/*.test.ts` | Add/update tests for changes |
| Documentation | `docs/*.md`, `readme.md` | Keep docs in sync |

##### What You Must NEVER Modify Directly

- **Production databases** — schema changes need migration scripts
- **User's `~/.bot/` data files** — that's user data, not yours to touch during self-improvement
- **The admin's primary repo** — you work in your workspace copy only
- **Environment files** (`.env`) — secrets are not your concern

#### 5. Build Check

After making changes, verify compilation:

```bash
# Server (Admin Mode only)
cd ~/.bot/workspace/dotbot/server
npx tsc --noEmit 2>&1

# Local Agent
cd ~/.bot/workspace/dotbot/local-agent
npx tsc --noEmit 2>&1
```

**Read the output carefully.** If there are errors:
- Read each error message
- Identify the root cause (don't just fix the symptom)
- Fix the issue
- Re-run the build check
- Maximum 5 fix attempts before rolling back

#### 6. Test Check

```bash
# Server tests (Admin Mode only)
cd ~/.bot/workspace/dotbot/server
npx vitest run 2>&1

# Local Agent tests
cd ~/.bot/workspace/dotbot/local-agent
npx vitest run 2>&1
```

**Read the output carefully.** You need:
- All existing tests still pass (no regressions)
- Any new tests you wrote also pass

If tests fail:
- Read the failure output — what test failed and why?
- Is it a real bug in your change, or a test that needs updating?
- Fix the issue and re-run tests
- Maximum 5 fix attempts before rolling back

#### 7. The Recursive Fix Loop

When build or tests fail, enter this loop:

```
ATTEMPT 1:
  → Read error output
  → Identify root cause
  → Make targeted fix
  → Re-run build + tests
  → Pass? → Continue to Step 8
  → Fail? → ATTEMPT 2

... up to ATTEMPT 5

ATTEMPT 5 FAILED:
  → STOP. Rollback (Step 9).
  → Report to user what you tried and why it didn't work.
```

**Each attempt must address a DIFFERENT root cause.** If you're making the same fix twice, you've misdiagnosed the problem. Stop and think before continuing.

#### 8. Commit and Merge

If build and tests pass:

```bash
cd ~/.bot/workspace/dotbot
git add -A
git commit -m "self-improve: <clear description of what changed and why>"

# Merge back to main
git checkout main
git merge self-improve/<branch-name>

# Clean up
git branch -d self-improve/<branch-name>
```

Tell the user what you changed, what tests pass, and how to pull the changes into their primary repo:

```bash
# In the admin's primary repo:
git remote add dotbot-workspace ~/.bot/workspace/dotbot
git fetch dotbot-workspace
git merge dotbot-workspace/main
# Or cherry-pick specific commits
```

#### 9. Rollback

If you can't get build + tests to pass after 5 attempts:

```bash
cd ~/.bot/workspace/dotbot
git checkout main
git branch -D self-improve/<branch-name>
```

Report to the user:
- What you were trying to do
- What errors you encountered
- What fixes you attempted
- Why you believe it's not working
- Suggest an alternative approach or ask for guidance

---

## Client Source Mode

In Client Source Mode, you can modify the **local-agent's TypeScript source code**, compile it, and deploy live updates. You CANNOT modify server code.

This gives clients the ability to improve tool handlers, add new tools, modify memory logic, and enhance the agent's runtime behavior — then push those changes live with safe rollback.

### Workspace Setup (First Time Only)

Same as Admin Mode, but you only need the local-agent:

```bash
mkdir -p ~/.bot/workspace
cd ~/.bot/workspace

# Clone from the upstream repo
git clone <REPO_URL> dotbot
cd dotbot

# Set up remotes
git remote rename origin upstream

# Install dependencies
npm install

# Build the shared package first (local-agent depends on @dotbot/shared)
npm run build -w shared

# Verify baseline
cd local-agent && npx tsc --noEmit && npx vitest run && cd ..
```

If the user already has the repo cloned elsewhere, clone from their local copy:

```bash
git clone /path/to/users/DotBot ~/.bot/workspace/dotbot
```

### What You Can Modify (Client Source)

| Area | Path | Examples |
|------|------|----------|
| Local agent code | `local-agent/src/**/*.ts` | Tool handlers, memory, store logic |
| Core tools | `local-agent/src/tools/*.ts` | Add/modify tools |
| Memory system | `local-agent/src/memory/*.ts` | Skill storage, knowledge, models |
| Default skills | `local-agent/src/memory/default-content/skills/*.md` | Skill markdown content |
| Default skill registry | `local-agent/src/memory/default-skills.ts` | Register new default skills |
| Tests | `local-agent/src/**/*.test.ts` | Add/update tests |
| All ~/.bot/ content | `~/.bot/skills/`, `~/.bot/personas/`, etc. | Skills, personas, knowledge, tools |

### What You CANNOT Modify (Client Source)

- **Server code** (`server/src/**`) — you don't have access
- **Server personas** (`server/src/personas/**`) — ship with the server
- **LLM routing/provider logic** — server-side only
- **Intake agents** (receptionist, planner, chairman) — server-side only

### The Client Source Improvement Cycle

Follow the same steps as Admin Mode (understand → sync → branch → change → build → test → fix loop → commit), but with these differences:

**Build check — local-agent only:**
```bash
cd ~/.bot/workspace/dotbot/local-agent
npx tsc --noEmit 2>&1
```

**Test check — local-agent only:**
```bash
cd ~/.bot/workspace/dotbot/local-agent
npx vitest run 2>&1
```

**After commit + merge → Deploy the update live** (see next section).

### Deploying a Live Update

After your changes pass build + tests, you deploy them to the running agent using the **staged deployment** workflow. The launcher wrapper handles the actual swap.

#### Step 1: Compile for Production

```bash
cd ~/.bot/workspace/dotbot/local-agent
npx tsc
```

This writes compiled JS to `~/.bot/workspace/dotbot/local-agent/dist/`.

#### Step 2: Copy Prompts

The build also needs prompt files (non-TypeScript assets):

```powershell
# Windows
xcopy "~\.bot\workspace\dotbot\local-agent\src\memory\prompts" "~\.bot\workspace\dotbot\local-agent\dist\memory\prompts" /E /I /Y /Q
```

```bash
# Linux/Mac
cp -r ~/.bot/workspace/dotbot/local-agent/src/memory/prompts ~/.bot/workspace/dotbot/local-agent/dist/memory/prompts
```

#### Step 3: Stage the Build

Copy the compiled output to the staging area where the launcher will pick it up:

```powershell
# Windows
$staged = "$env:USERPROFILE\.bot\workspace\staged-dist"
if (Test-Path $staged) { Remove-Item -Recurse -Force $staged }
Copy-Item -Recurse "~\.bot\workspace\dotbot\local-agent\dist" $staged
```

```bash
# Linux/Mac
rm -rf ~/.bot/workspace/staged-dist
cp -r ~/.bot/workspace/dotbot/local-agent/dist ~/.bot/workspace/staged-dist
```

#### Step 4: Signal the Launcher

Create the update marker file. The launcher watches for this:

```powershell
# Windows
"update" | Out-File "$env:USERPROFILE\.bot\workspace\update-pending" -Encoding ascii
```

```bash
# Linux/Mac
echo "update" > ~/.bot/workspace/update-pending
```

#### What Happens Next

The launcher (`local-agent/scripts/launcher.ps1` or `launcher.sh`) handles the rest:

1. **Detects** the `update-pending` marker
2. **Backs up** the current `dist/` to `~/.bot/workspace/dist-backup/`
3. **Promotes** the staged `staged-dist/` to `dist/`
4. **Cleans up** the marker and staging directory
5. **Restarts** the agent with the new code

If the new code **crashes within 10 seconds** of startup, the launcher **automatically rolls back** to the backup and restarts with the previous version.

#### Manual Rollback

If you need to force a rollback (the agent is running but behaving incorrectly):

```powershell
# Windows
"rollback" | Out-File "$env:USERPROFILE\.bot\workspace\rollback-pending" -Encoding ascii
```

```bash
# Linux/Mac
echo "rollback" > ~/.bot/workspace/rollback-pending
```

The launcher will detect this on the next restart cycle and restore from backup.

#### Important: Launcher Required

The staged deployment workflow **requires the launcher wrapper** to be running instead of raw `node dist/index.js`. The launcher scripts are at:

- **Windows**: `local-agent/scripts/launcher.ps1`
- **Linux/Mac**: `local-agent/scripts/launcher.sh`

If the user is running the agent directly without the launcher, tell them:

```
The self-update deployment requires the launcher wrapper. Start the agent with:
  PowerShell: powershell -ExecutionPolicy Bypass -File local-agent/scripts/launcher.ps1
  Bash: ./local-agent/scripts/launcher.sh

The launcher adds auto-restart, safe update deployment, and automatic rollback.
```

---

## Client Content Mode

In Client Content Mode, you have no source code access. You improve yourself by modifying content in `~/.bot/` — markdown files and JSON configs only.

### What You Can Do

| Action | Path | How |
|--------|------|-----|
| Create a skill | `~/.bot/skills/{slug}/SKILL.md` | Use `skills.save_skill` tool |
| Edit a skill | `~/.bot/skills/{slug}/SKILL.md` | Read, modify, write back |
| Add a persona | `~/.bot/personas/{slug}.md` | Write `.md` with YAML frontmatter |
| Add knowledge | `~/.bot/personas/{slug}/knowledge/*.md` | Write `.md` files |
| Create a council | `~/.bot/councils/{name}.md` | Write council definition |
| Save a learned tool | `~/.bot/tools/api/*.json` | Use `tools.save_tool` tool |

### Client Content Improvement Process

1. **Identify the improvement** — What capability is missing or weak?
2. **Choose the right mechanism**:
   - Need new instructions? → Create a skill
   - Need a new specialist? → Create a persona
   - Need reference material? → Add knowledge docs
   - Need a new API integration? → Discover and save a tool
3. **Create the content** — Write well-crafted markdown
4. **Verify it loaded** — Use list tools to confirm the system sees it
5. **Test it** — Try using the new capability in conversation

### Upgrading to Client Source Mode

If the user wants deeper self-improvement, help them set up the workspace:

1. They need the DotBot repo URL (GitHub, local path, etc.)
2. Clone it to `~/.bot/workspace/dotbot/`
3. Install dependencies: `npm install`
4. Verify baseline build + tests pass
5. Switch to running the agent via the launcher script

Now they're in Client Source Mode and you can modify actual TypeScript code.

---

## Pulling Upstream Updates

The admin's primary repo (or the official DotBot repo) is the source of truth. When updates are pushed:

```bash
cd ~/.bot/workspace/dotbot
git fetch upstream
git checkout main

# If you have local changes, merge carefully
git merge upstream/main

# If conflicts exist:
# 1. Read the conflict markers
# 2. Understand what upstream changed vs what you changed
# 3. Keep upstream's structural changes, re-apply your improvements on top
# 4. Build + test after resolving
```

**Priority rule**: Upstream structural changes (new files, API changes, architecture) take priority. Your improvements (prompt text, persona tweaks, skill content) layer on top.

After merging upstream, if you're in Client Source Mode, **rebuild and redeploy** using the staged deployment workflow above.

---

## What to Improve

When asked to improve yourself, consider these categories in order of impact:

### High Impact (Change Behavior)
- **Persona prompts** — Sharpen instructions, add examples, clarify edge cases
- **Skills** — Create new skills for common workflows
- **Tool prompt guidance** — Improve how tools are described to the LLM
- **Receptionist routing** — Better classification and persona selection (Admin only)

### Medium Impact (Add Capability)
- **New personas** — Specialists for uncovered domains
- **New tools** — Custom tool handlers for common operations (Client Source / Admin)
- **Knowledge docs** — Reference material that improves persona performance
- **Default skills** — New skills that ship with every installation
- **Learned tools** — Discover and save useful API integrations

### Low Impact (Polish)
- **Documentation** — README, guides, comments
- **Test coverage** — More tests for edge cases (Client Source / Admin)
- **Error messages** — Clearer failure reporting

---

## Safety Rules

These are non-negotiable:

1. **Never modify the primary repo directly.** Work in `~/.bot/workspace/dotbot/` only.
2. **Never skip tests.** If you can't run tests, you can't merge.
3. **Never force-push.** Use normal merges only.
4. **Never modify user data files** in `~/.bot/` as part of an Admin/Client Source improvement. (Client Content changes ARE user data — that's fine.)
5. **Always tell the user what you're doing** before you do it.
6. **Always tell the user what changed** after you do it.
7. **Roll back if stuck.** 5 failed attempts = rollback. No heroics.
8. **One improvement at a time.** Don't batch unrelated changes.
9. **Read the GUIDING_PRINCIPLES.md** before making architectural decisions. Your changes must align with DotBot's core philosophy.
10. **Preserve backward compatibility.** Don't break existing skills, personas, or tools that users depend on.
11. **Launcher required for live deploys.** Never overwrite a running agent's dist/ directly. Always use staged deployment.
12. **Server code is off-limits in Client Mode.** Even if you can see it in the workspace, don't modify `server/` unless you're in Admin Mode.
