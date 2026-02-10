---
title: SKILL.md Format Reference
description: How to create skills following the SKILL.md standard
tags: [skill, format, reference, standard]
---

# DotBot Skill Format (SKILL.md Standard)

Every skill is a directory at `~/.bot/skills/{slug}/` containing a `SKILL.md` file.
This follows the Claude Code skills standard.

## Directory Structure

```
~/.bot/skills/{slug}/
├── SKILL.md          # Required: YAML frontmatter + markdown instructions
├── scripts/          # Optional: executable scripts the skill references
│   └── run.js
├── examples/         # Optional: example outputs
│   └── sample.md
└── reference.md      # Optional: detailed reference docs
```

## SKILL.md Format

Every SKILL.md has two parts: YAML frontmatter (between --- markers) and markdown content with instructions.

```markdown
---
name: skill-name
description: What this skill does. Helps the system decide when to auto-load.
tags: [tag1, tag2, tag3]
disable-model-invocation: false
---

Instructions the LLM follows when this skill is invoked.

## Step 1: ...
## Step 2: ...
```

## Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Becomes the /slash-command |
| `description` | Yes | When to use this skill (helps auto-detection) |
| `tags` | No | Comma-separated or array for search/discovery |
| `disable-model-invocation` | No | If true, only user can trigger via /command |
| `user-invocable` | No | If false, background knowledge only (no /command) |
| `allowed-tools` | No | Restrict which tools the skill can use |

## Example: API Conventions Skill

```markdown
---
name: api-conventions
description: API design patterns for this codebase. Use when writing API endpoints.
tags: [api, rest, conventions]
---

When writing API endpoints:
- Use RESTful naming conventions
- Return consistent error formats: { error: string, code: number }
- Include request validation with Zod schemas
- Add OpenAPI annotations for documentation
- Use HTTP status codes correctly (201 for creation, 204 for deletion)
```

## Example: Deploy Skill (User-Only)

```markdown
---
name: deploy
description: Deploy the application to production
disable-model-invocation: true
---

Deploy $ARGUMENTS to production:
1. Run the test suite
2. Build the application
3. Push to the deployment target
4. Verify the deployment succeeded
```

## How to Save a Skill

Use the `save_skill` tool:
- `name`: The skill name (becomes /slug)
- `description`: When to use it
- `content`: The markdown instructions (body of SKILL.md)
- `tags`: Comma-separated keywords

## Common Mistakes

1. **Vague description** — Description should say what it does AND when to use it
2. **Too broad** — Skills should be focused on one task or domain
3. **Missing tags** — Tags help the system find and auto-load skills
4. **No structure** — Use headers and numbered steps for clarity
5. **Forgetting disable-model-invocation** — Set it for skills with side effects (deploy, send email)
