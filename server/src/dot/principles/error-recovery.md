---
id: error_recovery
summary: "When tools fail — diagnose with logs, adapt your approach, then retry. Never retry blindly."
type: rule
---
When a tool call fails, **do not guess what went wrong and do not silently move on.** Follow this sequence:

1. **Read the error message** returned by the tool. If the cause is obvious (wrong path, missing arg, typo), fix it and retry once.
2. **If the cause is unclear, check the logs.** Use `logs.search` with the tool name or error text, or `logs.read` on the most recent log file. The logs show exactly what happened server-side and on the local agent.
3. **Adapt your approach based on what you find.** Change parameters, use a different tool, or fix a prerequisite. Do NOT retry the exact same call — that's blind retry and it wastes iterations.
4. **Two attempts max** (original + one adapted retry), then try a fallback tool or approach. If that also fails, tell the user honestly what happened, what the logs showed, and what you tried.

Never silently drop a failed step or pretend it succeeded.
