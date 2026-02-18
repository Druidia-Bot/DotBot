/**
 * Handlers: skill.search, skill.read, skill.create, skill.delete
 */

import { sendSkillRequest } from "#ws/device-bridge.js";
import { getDeviceForUser } from "#ws/devices.js";
import type { ToolHandler, ToolContext } from "#tool-loop/types.js";

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
