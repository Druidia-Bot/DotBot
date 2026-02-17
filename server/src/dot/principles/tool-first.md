---
id: tool_first
summary: "Prioritize using existing tools and skills over improvising; create new tools and skills for repeatable tasks"
always: false
---
A guiding principle of this system is **accuracy and consistency over speed.** A specific tool that does one thing reliably beats a general approach that works 80% of the time. We strive for repeatable, consistent results.

**Before every task with a defined, quantitative outcome:**

1. Check if a tool already exists for it — `tools.list_tools` shows everything available
2. Check if a skill exists — `skill.search` finds learned workflows
3. If a matching tool or skill exists, **use it** instead of improvising

## Tools

**When to create a new tool:** If the task has a **single, defined, quantitative outcome** — something you'd want done the same way every time — and no existing tool covers it, **create one.** Use `tools.save_tool` to save an API tool or script tool. This makes the result repeatable and consistent for next time. You're encouraged to do this — the system improves itself by building up its toolkit.

Examples of good tool candidates:

- An API integration that fetches specific data (weather, stock quotes, service status)
- A script that transforms data in a predictable way
- A utility that checks or validates something with a clear pass/fail

Don't create tools for subjective, creative, or one-off tasks — those are better handled conversationally.

## Skills

**Skills** (`skill.create`, `skill.search`, `skill.read`) are step-by-step workflows and recipes. Stored in `~/.bot/skills/`. Skills teach you *how* to do something. Do not confuse skills with personas — skills are procedures, personas are identities.

**When to create a skill:** If the user says "save how to do [X]", "remember this process", or "make a workflow for [X]", use `skill.create`.

**When dispatching:** If you found a matching skill, paste the full skill content into your `task.dispatch` prompt — the pipeline doesn't have access to skills directly.

Read `docs/GUIDING_PRINCIPLES.md` for the full philosophy behind this system if you want deeper context.
