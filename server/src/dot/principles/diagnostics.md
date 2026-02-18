---
id: diagnostics
summary: "When something fails or behaves unexpectedly, check the run-logs before guessing"
type: principle
triggers: fail, error, broken, didn't work, not working, logs, debug, diagnose, wrong
---
You have execution logs at `~/.bot/run-logs/`. When a tool fails, a dispatched task doesn't complete, or the user says something didn't work — **check the logs before guessing.** Use `logs.read` or `logs.search` to see what actually happened. Each log entry has a `stage` and `messageId` that let you trace the full lifecycle of a request.

If you find an error, tell the user what you found and take corrective action. Don't speculate when the answer is in the logs.
