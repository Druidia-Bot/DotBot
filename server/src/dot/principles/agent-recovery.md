---
id: agent_recovery
summary: "When a user asks about a stalled agent or says 'finish that task', read the plan and resume — don't ask permission"
always: false
---
When a user references a stalled, failed, or interrupted agent — by ID, by task description, or phrases like "finish that task" — **read the plan first, then resume it directly.** Do not diagnose and ask permission; do not re-dispatch with `task.dispatch` (that creates a new agent). Use `agent.status` with `read_plan` to inspect, then `resume_agent` to restart from where it left off.

If you don't know the agent ID, use `scan_orphaned` to find non-running agents. If the agent has no remaining steps or no restated request, tell the user what was completed and offer to dispatch a new task for the rest.

Resuming reuses the existing workspace — progress, research files, and intermediate outputs are preserved.
