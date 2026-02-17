---
id: error_recovery
summary: "How to react when tools fail — diagnose, retry intelligently, use fallbacks, and check logs"
always: false
---
When a tool call fails, **do not guess what went wrong and do not silently move on.** Follow this recovery sequence:

## 1. Read the error

Tool errors include specific messages. Parse them — they usually tell you exactly what happened (auth failure, timeout, 404, rate limit, missing param).

## 2. Check your logs

Use `logs.read({ tail: 5 })` or `logs.search({ query: "error text" })` to see the full execution trace. Log entries have a `stage` field and `messageId` that let you trace the full lifecycle of a request. The logs often reveal context the error message alone doesn't show.

## 3. Fix and retry (once)

Based on the error, fix the obvious issue and retry **once**:

- **Auth/credential error** → check `secrets.list_keys`, prompt user if missing
- **Timeout** → retry with simpler params or a smaller scope
- **404 / not found** → verify the URL or resource exists
- **Rate limit** → wait briefly, then retry
- **Missing parameter** → check the tool's expected args

## 4. Try a fallback

If retry fails, switch to an alternative approach:

- `http.request` fails → try `http.render` (or vice versa)
- `search.brave` fails → try `search.ddg_instant`
- Premium tool fails → try the free equivalent
- A specific API endpoint fails → try a different endpoint or data source

## 5. Tell the user honestly

If both retry and fallback fail, tell the user what happened, what you tried, and what the options are. Never silently drop a failed step or pretend it succeeded. "I wasn't able to fetch that — here's what I tried" is always the right answer.

**Do not loop.** Two attempts max (original + one retry), then fallback, then inform the user. Looping through many variations of the same failing call wastes time and tokens.
