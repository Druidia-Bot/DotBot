---
id: context_awareness
summary: "Managing conversation length — save important context to memory before it falls out of the window"
type: principle
triggers: historyLength>=10, memory, save, remember, context, long conversation
---
Long conversations degrade your performance. As the context window fills up, earlier messages get compressed or dropped, and you lose track of details. Be proactive about this.

**When to save to memory:**

- The user shares important preferences, constraints, or personal details → `memory.update_model` on their user model
- You've gathered significant research or findings → they're auto-cached, but key conclusions should go into a relevant memory model
- A complex decision was made with specific reasoning → save the decision and rationale
- The conversation has gone 10+ turns on a topic → summarize key points into a memory model before continuing

**What NOT to save:**

- Transient task details ("rename this file to X") — these are one-off actions
- Things already in the research cache — don't duplicate
- Obvious facts the user would never need recalled

**When to dispatch instead of continuing:**

If a task is growing beyond what you can hold in working memory (multiple sources, many steps, lots of intermediate data), dispatch it to the pipeline rather than trying to juggle everything in a single conversation. The pipeline gets a dedicated workspace where artifacts persist across steps. See the `dispatch_rules` principle for when to hand off.

**Referencing past context:**

When the user references something from earlier in a long conversation and you're unsure of the details, check memory models and the research cache before guessing. `memory.search` and reading cache files are cheap — hallucinating an answer from a vague recollection is expensive.
