---
name: run-log-diagnostics
description: How to inspect your own execution logs to diagnose errors, slow responses, routing issues, and pipeline failures. Includes log format reference, common patterns, and resolution playbooks.
tags: [diagnostics, logs, debugging, self-repair, errors, pipeline]
disable-model-invocation: false
user-invocable: true
---

# Run-Log Diagnostics Skill

Your execution logs live at `~/.bot/run-logs/`. One JSONL file per day (`YYYY-MM-DD.log`), auto-pruned after 72 hours. Every pipeline run — from intake to completion — writes structured entries here.

**When to check your logs:**
- Something went wrong and you don't know why
- A user says "that didn't work" or "you didn't do what I asked"
- A tool call failed silently
- A response was slow or incomplete
- You want to understand how you handled a previous request
- After any error or unexpected behavior

---

## Tools

You have three dedicated tools:

| Tool | Purpose |
|------|---------|
| `logs.list` | List available log files with sizes and dates |
| `logs.read({ filename, tail? })` | Read entries from a specific day's log. Use `tail: N` for the most recent N entries |
| `logs.search({ query })` | Search across all logs for a keyword (case-insensitive, max 50 results) |

---

## Log Entry Format

Each line in a log file is a JSON object with at minimum:

```json
{
  "stage": "...",
  "messageId": "...",
  "_ts": "2026-02-16T14:30:00.000Z"
}
```

### Pipeline Stages (in order)

| Stage | What It Means | Key Fields |
|-------|---------------|------------|
| `intake` | Your intake agent classified the request | `prompt`, `requestType` |
| `fast-path` | Request was handled without full pipeline (simple Q&A) | `contextConfidence` |
| `agent-routing` | Checked if an existing agent should handle this | `decision` |
| `receptionist` | Receptionist selected persona + model | `agentId`, `personaId`, `modelTier` |
| `recruiter` | Recruiter selected tools for the task | `agentId`, `selectedTools` |
| `planner` | Planner created execution plan | `agentId`, `planSteps` |
| `dot-start` | Dot began processing (your main persona) | `source`, `contextMs` |
| `dot-complete` | Dot finished processing | `source`, `totalMs`, `toolCallCount`, `responseLength` |
| `execution-complete` | Pipeline agent finished its task | `agentId`, `success` |
| `error` | Something failed | `prompt`, `error` |
| `queue-recruiter` | Queued task recruiter phase | `agentId` |
| `queue-planner` | Queued task planner phase | `agentId` |
| `queue-execution-complete` | Queued task finished | `agentId` |

---

## Diagnostic Playbooks

### "Something went wrong" — General Triage

1. `logs.list` — find today's log file
2. `logs.read({ filename: "YYYY-MM-DD.log", tail: 20 })` — read the most recent entries
3. Look for `stage: "error"` entries — these have the `error` field with details
4. Trace the `messageId` — find the full lifecycle (intake → receptionist → ... → complete/error)

### "My tool call failed"

1. `logs.search({ query: "error" })` — find recent errors
2. Look at the `error` field — common causes:
   - **"No local agent connected"** — the WebSocket connection dropped. Check if the agent process is running.
   - **"Tool not found"** — the tool ID doesn't exist in the manifest. Use `tools.list_tools` to verify.
   - **"Access denied"** — security policy blocked the operation (e.g., writing to a system path).
   - **"timeout"** — the tool took too long. May need to retry or break the task into smaller pieces.
3. If the error is in YOUR code (a tool you created), read the tool source and fix it.

### "Response was slow"

1. `logs.search({ query: "dot-complete" })` — find recent completions
2. Check the `totalMs` field — normal is 2-15 seconds. Over 30s is slow.
3. Check `contextMs` — if this is high, context building (memory fetch) was slow.
4. Check `toolCallCount` — many tool calls = many round trips. Consider if you're being too granular.

### "Wrong persona/model was selected"

1. `logs.search({ query: "receptionist" })` — find routing decisions
2. Check `personaId` and `modelTier` — was the right specialist chosen?
3. If routing is consistently wrong, consider:
   - Updating your identity traits to better reflect your capabilities
   - Creating a skill that explicitly handles the misrouted task type

### "Pipeline task didn't complete"

1. Find the `messageId` from the dispatch
2. `logs.search({ query: "<messageId>" })` — trace all stages
3. Look for where the chain breaks — if you see `recruiter` but no `planner`, the planner failed
4. Check for `error` entries with that `messageId`

### "I don't remember handling that request"

1. Ask the user approximately when they sent it
2. `logs.read({ filename: "YYYY-MM-DD.log" })` — read that day's log
3. Search for keywords from their request: `logs.search({ query: "keyword" })`
4. The `intake` stage has the original `prompt` (truncated to 500 chars)

---

## Proactive Self-Monitoring

When you notice something went wrong during a conversation:

1. **Check logs immediately** — don't guess. Use `logs.read` with `tail: 10` to see what just happened.
2. **Tell the user what you found** — "I checked my logs and saw [specific error]. Here's what happened..."
3. **Take corrective action** — retry the operation, use a different approach, or explain what needs to change.
4. **If it's a recurring issue**, create a note in your mental model about the pattern so you can watch for it.

---

## Important Notes

- Logs are **append-only JSONL** — one JSON object per line, newline-separated
- Files are **auto-pruned after 72 hours** — if you need to investigate something older, it's gone
- The `_ts` field is the ISO timestamp of when the entry was written
- The `messageId` field links all stages of a single request together — use it to trace a full lifecycle
- Logs do NOT contain the full response text or tool arguments (to keep file sizes manageable) — they contain metadata about what happened
