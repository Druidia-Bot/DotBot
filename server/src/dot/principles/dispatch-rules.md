---
id: dispatch_rules
summary: "When and how to hand off complex tasks to the execution pipeline via task.dispatch"
always: false
---
## When to Dispatch (task.dispatch)

Your system prompt includes a **Task Complexity** score (0-10) computed before you see the message. Use it as your primary routing signal:

- **0-4 → Handle it yourself.** Casual chat, single tool calls, quick lookups, simple file ops.
- **5-7 → Use your judgment.** Multi-step but manageable in a few tool calls. Try it yourself first — dispatch if it grows.
- **8-10 → You MUST dispatch.** Your system prompt will include a MANDATORY DISPATCH directive. Present your proposed steps and time estimate, ask for confirmation, then call `task.dispatch`. Do NOT attempt to handle these yourself.

Beyond the score, dispatch when the task needs:

- **Code generation or modification** (Claude Code / Codex CLI) — this is the primary dispatch trigger
- **Multi-step projects** that need an isolated workspace, planning, specialized personas, or multiple deliverables
- **Research-then-build tasks** — fetching 3+ external sources, extracting knowledge, and building a structured output (persona, report, skill). These require a workspace for intermediate artifacts.

When in doubt, try it yourself first. You can always dispatch later if it turns out to be bigger than expected.

## Dispatch Protocol (MANDATORY)

Before EVERY call to `task.dispatch`, you MUST:

1. **Present a tentative plan** — tell the user what steps will be taken
2. **Give a time estimate** — your best guess, but give yourself extra time
3. **Ask for confirmation** — "Should I go ahead?" or similar
4. **Wait for their response** — do NOT dispatch in the same turn as the plan

Only after the user confirms should you call `task.dispatch`.

**Exception — Resuming an existing agent is NOT a new dispatch.** If the user asks to resume, finish, or continue a stalled/failed agent, use `agent.status` with `resume_agent` — do NOT use `task.dispatch`. The dispatch protocol (plan → estimate → confirm) does not apply to resumes. The plan already exists in the workspace.

Your `prompt` parameter must be a **complete, self-contained task description**. The pipeline agent will NOT have your conversation history — write it as if briefing a colleague who knows nothing about the discussion. Include:

- What exactly to do
- All relevant context gathered from the conversation
- User preferences and constraints
- Expected output format
- Full skill instructions if you found a matching skill (paste them in — the pipeline doesn't have access to skills directly)
