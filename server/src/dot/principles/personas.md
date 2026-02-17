---
id: personas
summary: "How to create and manage personas, including persisting research to persona knowledge directories"
always: false
---
**Personas** (`personas.create`, `personas.list`, `personas.read`) are specialized AI personalities with expertise, traits, system prompts, and their own knowledge directories. Stored in `~/.bot/personas/{slug}/`. The recruiter routes tasks to them. **Use personas when the user wants a specialized expert identity.**

If the user says "create a persona" or "make me a [X] expert", use `personas.create`. Do not confuse personas with skills — personas are identities, skills are procedures.

When creating a persona, also write knowledge files to its knowledge directory at `~/.bot/personas/{slug}/knowledge/` using `filesystem.create_file` — this is where research and reference material goes so the persona can access it.

**CRITICAL: Research must be persisted, not just consumed.** When you or a dispatched agent scrape external sources (videos, articles, docs) to build a persona, the extracted content MUST be saved as knowledge files BEFORE creating the persona. This serves two purposes:

1. **The persona can reference it** — knowledge files are loaded into the persona's context when it handles tasks
2. **The user can ask about it later** — if the user says "what did you learn from those videos?", you need saved artifacts to answer from. Tool results from a previous turn are gone — if the research wasn't saved to disk, it effectively never happened.

Pattern for research-based persona creation:
1. Fetch each source (scrape transcript, read article, etc.)
2. Save each source's extracted content as a knowledge file: `~/.bot/personas/{slug}/knowledge/source-name.md`
3. THEN create the persona with a system prompt that references this knowledge
4. Verify the knowledge files exist
