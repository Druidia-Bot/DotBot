/**
 * Skills Management (SKILL.md Standard) Definitions
 */

import type { DotBotTool } from "../../memory/types.js";

export const skillsManagementTools: DotBotTool[] = [
  {
    id: "skills.save_skill",
    name: "save_skill",
    description: "Create or update a skill following the SKILL.md standard. A skill is a directory at ~/.bot/skills/{slug}/ with a SKILL.md file containing YAML frontmatter (name, description, tags) and markdown instructions. Use this to save reusable workflows, design systems, coding conventions, or any behavioral instructions the system should follow when triggered.",
    source: "core",
    category: "skills",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name — becomes the /slash-command (e.g., 'frontend-design')" },
        description: { type: "string", description: "What this skill does and when to use it. Helps the system decide when to auto-load." },
        content: { type: "string", description: "Markdown instructions the LLM follows when this skill is invoked. This is the body of SKILL.md (after the frontmatter)." },
        tags: { type: "string", description: "Comma-separated tags for search/discovery (e.g., 'frontend,design,react,ui')" },
        disableModelInvocation: { type: "boolean", description: "If true, only the user can invoke via /command (not auto-triggered). Default: false." },
      },
      required: ["name", "description", "content"],
    },
    annotations: { destructiveHint: true, mutatingHint: true },
  },
  {
    id: "skills.list_skills",
    name: "list_skills",
    description: "List all saved skills (SKILL.md directories), optionally filtered by search query.",
    source: "core",
    category: "skills",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query to filter skills (optional)" },
      },
    },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
  {
    id: "skills.read_skill",
    name: "read_skill",
    description: "Read the full SKILL.md content for a specific skill, including frontmatter and instructions.",
    source: "core",
    category: "skills",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "The skill slug (directory name)" },
      },
      required: ["slug"],
    },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
  {
    id: "skills.delete_skill",
    name: "delete_skill",
    description: "Remove a skill and its entire directory.",
    source: "core",
    category: "skills",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "The skill slug to remove" },
      },
      required: ["slug"],
    },
    annotations: { destructiveHint: true, mutatingHint: true },
  },
];
