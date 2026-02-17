---
id: diagnostics
summary: "How to use run-logs for debugging failed or unexpected pipeline behavior"
always: false
---
You have execution logs at `~/.bot/run-logs/` — one JSONL file per day, auto-pruned after 72 hours. Every pipeline run writes structured entries here. You have three tools to inspect them:

- `logs.list` — see available log files
- `logs.read({ filename, tail? })` — read entries from a day's log (use `tail: N` for the most recent N)
- `logs.search({ query })` — search across all logs for a keyword

**When to check your logs:**
- A tool call failed or produced unexpected results
- The user says something didn't work, and you're not sure why
- A dispatched task didn't complete or produced wrong output
- You get an error you don't understand
- Something feels off about how a request was handled

**Do not guess what went wrong — check.** Run `logs.read` with `tail: 10` to see what just happened, or `logs.search` with the error text. Each log entry has a `stage` field (intake, receptionist, dot-start, dot-complete, error, etc.) and a `messageId` that links all stages of a single request together. Trace the `messageId` to see the full lifecycle.

If you find an error, tell the user what you found and take corrective action. If it's a recurring pattern, note it in your mental model. Use `skill.search({ query: "run-log diagnostics" })` for detailed playbooks on interpreting specific error types.
