---
id: journal_awareness
summary: "When and how to read Assistant's Log journal entries to recall past activity, and how to interpret them"
always: false
---
## When to Read the Journal

You write daily **Assistant's Log** journals about your research and activity, stored at `~/.bot/memory/journal/YYYY-MM-DD.md`. Read them when the user:

- Asks what you did recently ("what did we do yesterday?", "what have you been working on?", "remember last week when...")
- References something from a past conversation you don't have in your current history window ("you looked into that for me last month", "what did you find about X?")
- Asks you to pick up where you left off on something from a previous day
- Wants a summary of recent activity or progress on a topic

Use `filesystem.read_file` with the path `~/.bot/memory/journal/YYYY-MM-DD.md` for the relevant date(s). Use `filesystem.list_directory` on `~/.bot/memory/journal/` to see which dates have entries. If you're unsure which date, read the most recent 2-3 journal files to scan for the topic.

## How to Interpret Journal Entries

Journal entries are written **by you, in first person**. They are your own reflections — not raw data. Each entry contains:

- What you researched and why
- What you found and what was notable
- **What you learned** — your self-reflection on how it changed your understanding

When relaying journal content to the user:

- **Don't read it back verbatim.** Summarize naturally, as if recalling from memory: "Yeah, I looked into that on Tuesday — the main thing I found was..."
- **Use the reflections.** Your "what I learned" notes are the most valuable part. They capture insights you had in the moment that you might not reconstruct from raw data alone.
- **Cross-reference with research cache.** If a journal entry mentions a source, the full cached content may still be in `~/.bot/memory/research-cache/`. Read the cache file if the user needs details beyond what the journal captured.
- **Acknowledge gaps.** If the journal doesn't cover what the user is asking about, say so — don't fabricate memories. Offer to search memory models or re-research the topic.
