/**
 * Skills Management Handler
 */

import type { ToolExecResult } from "../_shared/types.js";
import { createSkill, getAllSkills, getSkill, searchSkills, deleteSkill } from "../../memory/store-skills.js";

export async function handleSkillsManagement(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "skills.save_skill": {
      if (!args.name || !args.description || !args.content) {
        return { success: false, output: "", error: "Missing required fields: name, description, content" };
      }

      const tags = typeof args.tags === "string"
        ? args.tags.split(",").map((t: string) => t.trim())
        : (args.tags || []);

      const skill = await createSkill(
        args.name,
        args.description,
        args.content,
        tags,
        {
          disableModelInvocation: args.disableModelInvocation || false,
        }
      );

      return {
        success: true,
        output: `Saved skill: "${skill.name}" (/${skill.slug})\nTags: ${skill.tags.join(", ") || "none"}\nPath: ~/.bot/skills/${skill.slug}/SKILL.md\nThis skill is now available in all future conversations.`,
      };
    }

    case "skills.list_skills": {
      let skills;
      if (args.query) {
        skills = await searchSkills(args.query);
      } else {
        skills = (await getAllSkills()).map(s => ({
          slug: s.slug,
          name: s.name,
          description: s.description,
          tags: s.tags,
          disableModelInvocation: s.disableModelInvocation,
          userInvocable: s.userInvocable,
        }));
      }

      if (skills.length === 0) {
        return { success: true, output: "No skills found." };
      }

      const lines = skills.map((s: any) => {
        const flags = [];
        if (s.disableModelInvocation) flags.push("user-only");
        if (s.userInvocable === false) flags.push("background");
        const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
        const tagStr = s.tags?.length > 0 ? ` (${s.tags.join(", ")})` : "";
        return `  /${s.slug}${flagStr} — ${s.description.substring(0, 80)}${s.description.length > 80 ? "..." : ""}${tagStr}`;
      });

      return { success: true, output: `${skills.length} skills:\n${lines.join("\n")}` };
    }

    case "skills.read_skill": {
      if (!args.slug) return { success: false, output: "", error: "Missing required field: slug" };

      const skill = await getSkill(args.slug);
      if (!skill) return { success: false, output: "", error: `Skill not found: ${args.slug}` };

      const parts = [
        `# /${skill.name}`,
        `**Description:** ${skill.description}`,
        skill.tags.length > 0 ? `**Tags:** ${skill.tags.join(", ")}` : "",
        skill.supportingFiles.length > 0 ? `**Supporting files:** ${skill.supportingFiles.join(", ")}` : "",
        "",
        "## Instructions",
        "",
        skill.content,
      ].filter(Boolean);

      return { success: true, output: parts.join("\n") };
    }

    case "skills.delete_skill": {
      if (!args.slug) return { success: false, output: "", error: "Missing required field: slug" };

      const skill = await getSkill(args.slug);
      if (!skill) return { success: false, output: "", error: `Skill not found: ${args.slug}` };

      await deleteSkill(args.slug);
      return { success: true, output: `Deleted skill: ${args.slug} (directory removed)` };
    }

    default:
      return { success: false, output: "", error: `Unknown skills management tool: ${toolId}` };
  }
}
