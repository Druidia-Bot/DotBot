/**
 * Persona Management Handler
 */

import { promises as fs } from "fs";
import { resolve, join } from "path";
import * as os from "os";
import type { ToolExecResult } from "../_shared/types.js";
import {
  getPersona,
  getPersonasIndex,
} from "../../memory/personas.js";
import {
  savePersonaFile,
  loadPersona,
  loadAllPersonas,
} from "../../memory/persona-files.js";
import type { PersonaConfig } from "../../memory/persona-files.js";

const PERSONAS_DIR = resolve(os.homedir(), ".bot", "personas");

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function handlePersonas(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "personas.create": {
      const name = args.name;
      const role = args.role;
      const systemPrompt = args.system_prompt;
      if (!name) return { success: false, output: "", error: "name is required" };
      if (!role) return { success: false, output: "", error: "role is required" };
      if (!systemPrompt) return { success: false, output: "", error: "system_prompt is required" };

      const slug = slugify(name);

      // Check both .md and persona.json formats for existing persona
      const existingMd = await loadPersona(slug);
      const existingDir = await getPersona(slug);
      if (existingMd || existingDir) {
        return { success: false, output: "", error: `Persona "${slug}" already exists. Use a different name or delete the existing one first.` };
      }

      const parseList = (val: string | undefined): string[] => {
        if (!val) return [];
        return val.split(",").map(s => s.trim()).filter(Boolean);
      };

      const persona: PersonaConfig = {
        id: slug,
        name,
        description: args.description || role,
        systemPrompt,
        modelTier: args.model_tier || "smart",
        tools: parseList(args.tools),
        role,
        traits: parseList(args.traits),
        expertise: parseList(args.expertise),
        triggers: parseList(args.triggers),
      };

      // Save as .md file
      await savePersonaFile(persona);

      // Create knowledge directory for this persona
      const knowledgeDir = join(PERSONAS_DIR, slug, "knowledge");
      await fs.mkdir(knowledgeDir, { recursive: true });

      return {
        success: true,
        output: `Created persona "${name}" (slug: ${slug})\n` +
          `  Role: ${role}\n` +
          `  Model tier: ${persona.modelTier}\n` +
          `  Tools: ${persona.tools.length > 0 ? persona.tools.join(", ") : "none"}\n` +
          `  Expertise: ${(persona.expertise || []).length > 0 ? persona.expertise!.join(", ") : "not specified"}\n` +
          `  Saved to: ~/.bot/personas/${slug}.md`,
      };
    }

    case "personas.list": {
      // Merge .md file personas and directory-based persona.json personas
      const mdPersonas = await loadAllPersonas();
      const index = await getPersonasIndex();

      const merged = new Map<string, { name: string; id: string; role: string; modelTier: string; knowledgeFileCount: number }>();

      // .md personas
      for (const p of mdPersonas) {
        merged.set(p.id, {
          name: p.name, id: p.id, role: p.role || p.description || "",
          modelTier: p.modelTier, knowledgeFileCount: 0,
        });
      }
      // Directory-based personas (may overlap, directory wins for knowledge count)
      for (const p of index.personas) {
        const existing = merged.get(p.slug);
        merged.set(p.slug, {
          name: p.name, id: p.slug, role: p.role,
          modelTier: p.modelTier, knowledgeFileCount: p.knowledgeFileCount,
        });
      }

      if (merged.size === 0) {
        return { success: true, output: "No local personas found. Use personas.create to create one." };
      }

      const entries = [...merged.values()].map(p =>
        `- **${p.name}** (${p.id}) — ${p.role}\n  Tier: ${p.modelTier} | Knowledge files: ${p.knowledgeFileCount}`
      );

      return {
        success: true,
        output: `${merged.size} local persona(s):\n\n${entries.join("\n\n")}`,
      };
    }

    case "personas.read": {
      const slug = args.slug;
      if (!slug) return { success: false, output: "", error: "slug is required" };

      // Check directory-based persona.json first (richer), then .md
      const dirPersona = await getPersona(slug);
      if (dirPersona) {
        return {
          success: true,
          output: JSON.stringify({
            slug: dirPersona.slug,
            name: dirPersona.name,
            role: dirPersona.role,
            description: dirPersona.description,
            modelTier: dirPersona.modelTier,
            tools: dirPersona.tools,
            traits: dirPersona.traits,
            expertise: dirPersona.expertise,
            triggers: dirPersona.triggers,
            knowledgeFiles: dirPersona.knowledgeFiles,
            systemPrompt: dirPersona.systemPrompt,
            createdAt: dirPersona.createdAt,
            lastUpdatedAt: dirPersona.lastUpdatedAt,
          }, null, 2),
        };
      }

      const mdPersona = await loadPersona(slug);
      if (mdPersona) {
        return {
          success: true,
          output: JSON.stringify({
            slug: mdPersona.id,
            name: mdPersona.name,
            role: mdPersona.role || "",
            description: mdPersona.description,
            modelTier: mdPersona.modelTier,
            tools: mdPersona.tools,
            traits: mdPersona.traits || [],
            expertise: mdPersona.expertise || [],
            triggers: mdPersona.triggers || [],
            systemPrompt: mdPersona.systemPrompt,
          }, null, 2),
        };
      }

      return { success: false, output: "", error: `Persona not found: ${slug}` };
    }

    default:
      return { success: false, output: "", error: `Unknown persona tool: ${toolId}` };
  }
}
