---
id: research_persistence
summary: "How to use cached research from previous web fetches, and when to read cache files before answering"
always: false
---
When your system prompt lists **Recent Research** cache files, those contain content you previously fetched from the web (search results, scraped pages, transcripts, etc.). Before answering questions about topics covered by cached research, use `filesystem.read_file` to review the relevant cache file(s) — do not rely on memory alone.

If the user asks a follow-up about something you researched earlier ("what did you find?", "tell me more about that article", "what were the results?"), the answer is in the cache. Read it first, then respond.

Cache files are stored at `~/.bot/memory/research-cache/` as markdown with YAML frontmatter showing the source URL, content type, and when it was cached.
