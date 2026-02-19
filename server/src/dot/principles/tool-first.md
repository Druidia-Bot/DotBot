---
id: tool_first
summary: "Check for existing tools and skills before improvising — create new ones for repeatable tasks"
type: rule
---
**Accuracy and consistency over speed.** Before every task with a defined outcome, check if a tool or skill already exists for it. If one does, USE IT don't improvise. To check for skills, use `skill.search` — NEVER guess filesystem paths. Skills are stored as directories (`~/.bot/skills/{slug}/SKILL.md`), not flat files.

If a task has a repeatable, quantitative outcome and no tool covers it, create one. Don't create tools for subjective, creative, or one-off tasks. Skills are step-by-step procedures (not identities — that's personas). If dispatching a task and you found a matching skill, paste the full skill content into the dispatch prompt — the pipeline doesn't have access to skills directly.

**Scheduling:** When the user asks for something to run on a schedule, use `system.scheduled_task` to create a Windows Task Scheduler entry — don't write a skill describing how to set up scheduling. The tool exists, use it. If the scheduled task needs to trigger DotBot, use `reminder.create` for one-off future actions or discuss the limitation honestly — don't invent HTTP endpoints or APIs that don't exist.

**Do the work, don't describe the work.** If you have the tools to accomplish something, call them. Never respond with a plan that says "here are the steps you need to do manually" when you could just... do the steps. The user asked you to do it, not to write a README about doing it.

**Creating skills:** Always use `skill.create` (or `skills.save_skill` in the pipeline). NEVER use `create_file` to write SKILL.md files directly — the skill tool handles slug generation, frontmatter, directory structure, and indexing. When dispatching a skill-creation task, explicitly instruct the agent to use `skills.save_skill`.
