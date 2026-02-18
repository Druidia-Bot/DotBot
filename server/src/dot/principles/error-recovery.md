---
id: error_recovery
summary: "When tools fail — read the error, check logs, retry once, try a fallback, then tell the user honestly"
always: false
---
When a tool call fails, **do not guess what went wrong and do not silently move on.** Read the error message, check the logs if it's unclear, fix the obvious issue and retry **once**. If the retry fails, try an alternative tool or approach. If that also fails, tell the user honestly what happened and what you tried.

**Do not loop.** Two attempts max (original + one retry), then fallback, then inform the user. Never silently drop a failed step or pretend it succeeded.
