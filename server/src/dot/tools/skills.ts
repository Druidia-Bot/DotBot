/**
 * Dot Tools — Skill CRUD
 *
 * Full skill management via WebSocket to the local agent:
 *   - skill.search  — search available skills
 *   - skill.read    — read a specific skill's content
 *   - skill.create  — create or update a skill
 *   - skill.delete  — delete a skill
 */

import { sendSkillRequest } from "#ws/device-bridge.js";
import { getDeviceForUser } from "#ws/devices.js";
import type { ToolDefinition } from "#llm/types.js";
import type { ToolHandler, ToolContext } from "#tool-loop/types.js";

// ============================================
// SKILL.SEARCH
// ============================================

export const SKILL_SEARCH_TOOL_ID = "skill.search";

export function skillSearchDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: "skill__search",
      description:
        "Search for predefined skills that match a task description. Skills are learned " +
        "workflows with step-by-step instructions. If a matching skill exists, you can " +
        "read it and include the instructions in your task.dispatch prompt.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What kind of task or workflow you're looking for",
          },
        },
        required: ["query"],
      },
    },
  };
}

export function skillSearchHandler(): ToolHandler {
  return async (ctx: ToolContext, args: Record<string, any>): Promise<string> => {
    const userId = ctx.state.userId as string;
    const deviceId = getDeviceForUser(userId);
    if (!deviceId) return "No local agent connected — cannot search skills.";

    const query = args.query || "";
    try {
      const results = await sendSkillRequest(deviceId, { action: "search_skills", query });
      if (!results || !Array.isArray(results) || results.length === 0) {
        return "No matching skills found.";
      }
      const formatted = results.map((s: any) =>
        `- **${s.name}** (slug: \`${s.slug}\`): ${s.description || "no description"}` +
        (s.tags?.length ? ` [${s.tags.join(", ")}]` : "")
      ).join("\n");
      return `Found ${results.length} skill(s):\n${formatted}`;
    } catch (err) {
      return `Skill search failed: ${err instanceof Error ? err.message : err}`;
    }
  };
}

// ============================================
// SKILL.READ
// ============================================

export const SKILL_READ_TOOL_ID = "skill.read";

export function skillReadDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: "skill__read",
      description: "Read the full content of a specific skill by its slug.",
      parameters: {
        type: "object",
        properties: {
          slug: {
            type: "string",
            description: "The skill slug (from skill.search results)",
          },
        },
        required: ["slug"],
      },
    },
  };
}

export function skillReadHandler(): ToolHandler {
  return async (ctx: ToolContext, args: Record<string, any>): Promise<string> => {
    const userId = ctx.state.userId as string;
    const deviceId = getDeviceForUser(userId);
    if (!deviceId) return "No local agent connected — cannot read skill.";

    const slug = args.slug || "";
    if (!slug) return "Error: slug is required.";

    try {
      const skill = await sendSkillRequest(deviceId, { action: "get_skill", skillSlug: slug });
      if (!skill) return `Skill "${slug}" not found.`;
      return `## ${skill.name}\n\n${skill.content || "(empty)"}`;
    } catch (err) {
      return `Skill read failed: ${err instanceof Error ? err.message : err}`;
    }
  };
}

// ============================================
// SKILL.CREATE
// ============================================

export const SKILL_CREATE_TOOL_ID = "skill.create";

export function skillCreateDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: "skill__create",
      description:
        "Create or update a reusable skill. Skills are saved workflows with step-by-step " +
        "instructions that the system can follow. Use this to save a workflow you've learned, " +
        "a design system, coding conventions, or any behavioral instructions worth reusing.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Skill name — becomes the slug (e.g., 'frontend-design')",
          },
          description: {
            type: "string",
            description: "What this skill does and when to use it",
          },
          content: {
            type: "string",
            description: "Markdown instructions the system follows when this skill is invoked",
          },
          tags: {
            type: "string",
            description: "Comma-separated tags for search/discovery (e.g., 'frontend,design,react')",
          },
        },
        required: ["name", "description", "content"],
      },
    },
  };
}

export function skillCreateHandler(): ToolHandler {
  return async (ctx: ToolContext, args: Record<string, any>): Promise<string> => {
    const userId = ctx.state.userId as string;
    const deviceId = getDeviceForUser(userId);
    if (!deviceId) return "No local agent connected — cannot create skill.";

    const { name, description, content } = args;
    if (!name || !description || !content) {
      return "Error: name, description, and content are all required.";
    }

    const tags = args.tags
      ? (typeof args.tags === "string" ? args.tags.split(",").map((t: string) => t.trim()) : args.tags)
      : [];

    try {
      const result = await sendSkillRequest(deviceId, {
        action: "create_skill",
        data: { name, description, content, tags },
      });
      if (!result) return "Skill created (no details returned).";
      return `Skill created: **${result.name || name}** (slug: \`${result.slug || name}\`)`;
    } catch (err) {
      return `Skill creation failed: ${err instanceof Error ? err.message : err}`;
    }
  };
}

// ============================================
// SKILL.DELETE
// ============================================

export const SKILL_DELETE_TOOL_ID = "skill.delete";

export function skillDeleteDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: "skill__delete",
      description: "Delete a skill and its entire directory by slug.",
      parameters: {
        type: "object",
        properties: {
          slug: {
            type: "string",
            description: "The skill slug to delete",
          },
        },
        required: ["slug"],
      },
    },
  };
}

export function skillDeleteHandler(): ToolHandler {
  return async (ctx: ToolContext, args: Record<string, any>): Promise<string> => {
    const userId = ctx.state.userId as string;
    const deviceId = getDeviceForUser(userId);
    if (!deviceId) return "No local agent connected — cannot delete skill.";

    const slug = args.slug || "";
    if (!slug) return "Error: slug is required.";

    try {
      const result = await sendSkillRequest(deviceId, { action: "delete_skill", skillSlug: slug });
      if (result === false) return `Skill "${slug}" not found.`;
      return `Skill "${slug}" deleted.`;
    } catch (err) {
      return `Skill deletion failed: ${err instanceof Error ? err.message : err}`;
    }
  };
}
