/**
 * Persona Management Tool Definitions
 */

import type { DotBotTool } from "../../memory/types.js";

export const personaTools: DotBotTool[] = [
  {
    id: "personas.create",
    name: "create_persona",
    description: `Create a new local persona. A persona defines a specialized AI personality with specific expertise, tools, and behavior. Saved to ~/.bot/personas/{slug}/ with a persona.json and knowledge/ directory.

The persona will be available for the receptionist to route tasks to. Give it a clear role description and specific expertise areas so the receptionist knows when to use it.`,
    source: "core",
    category: "personas",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name (e.g., 'Marketing Strategist', 'Data Analyst')" },
        role: { type: "string", description: "One-line role description (e.g., 'Expert in digital marketing strategy and campaign optimization')" },
        description: { type: "string", description: "Detailed description of capabilities, approach, and when to use this persona" },
        system_prompt: { type: "string", description: "The full system prompt that defines this persona's behavior, tone, and expertise. Be specific and detailed." },
        model_tier: { type: "string", description: "'fast' (quick tasks), 'smart' (analysis), or 'powerful' (complex reasoning). Default: 'smart'", enum: ["fast", "smart", "powerful"] },
        tools: { type: "string", description: "Comma-separated tool categories this persona can use (e.g., 'filesystem,directory,shell,http'). Use 'all' for everything, 'none' for no tools." },
        traits: { type: "string", description: "Comma-separated personality traits (e.g., 'analytical,precise,thorough')" },
        expertise: { type: "string", description: "Comma-separated areas of expertise (e.g., 'SEO,content marketing,analytics,A/B testing')" },
        triggers: { type: "string", description: "Comma-separated trigger phrases that should route to this persona (e.g., 'marketing,campaign,SEO,ads,social media')" },
      },
      required: ["name", "role", "system_prompt"],
    },
    annotations: { destructiveHint: true, mutatingHint: true },
  },
  {
    id: "personas.list",
    name: "list_personas",
    description: "List all local personas with their name, role, model tier, and knowledge file count.",
    source: "core",
    category: "personas",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
  {
    id: "personas.read",
    name: "read_persona",
    description: "Read a local persona's full definition including system prompt, tools, traits, expertise, and knowledge files.",
    source: "core",
    category: "personas",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Persona slug (directory name)" },
      },
      required: ["slug"],
    },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
];
