/**
 * Dot-Exclusive Tool Definitions
 *
 * Tools that ONLY Dot has access to — not available to pipeline agents.
 * These are Dot's personal tools: identity management, backstory, and dispatch.
 *
 * Shared tools (skills, logs, agent, search, tools) live in
 * server/src/tools/definitions/server-tools.ts and are available to all callers.
 */

import type { DotToolDefinition } from "../types.js";
import { SHARED_SERVER_TOOLS } from "#tools/definitions/server-tools.js";

// ── Dispatch ──────────────────────────────────────────────

export const dispatch: DotToolDefinition[] = [
  {
    id: "task.dispatch",
    name: "task__dispatch",
    description:
      "Dispatch a task to the full execution pipeline. The pipeline will create a workspace, " +
      "select specialized tools and personas, plan the work, and execute it. Use this for advanced tasks " +
      "that require custom file creation, code generation, multi-step research, lots of shell commands, or any " +
      "work you cannot complete quickly. You MUST present a tentative plan and time " +
      "estimate to the user and receive their confirmation BEFORE calling this tool.",
    category: "dispatch",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "A fully-formed, detailed task description or full skill.md content for the pipeline. Include all context " +
            "from your conversation — the pipeline agent won't have your chat history. Be specific " +
            "about what to do, what the user wants, constraints, preferences, and expected output.",
        },
        estimated_minutes: {
          type: "number",
          description: "Your estimated time for this task in minutes.",
        },
      },
      required: ["prompt"],
    },
    hints: { mutating: true, verification: false },
  },
];

// ── Identity ──────────────────────────────────────────────

export const identity: DotToolDefinition[] = [
  {
    id: "identity.read",
    name: "identity__read",
    description:
      "Read your current identity (me.json). Returns your name, role, traits, ethics, " +
      "code of conduct, communication style, properties, and human instructions.",
    category: "identity",
    inputSchema: {
      type: "object",
      properties: {},
    },
    hints: { mutating: false, verification: true },
  },
  {
    id: "identity.update",
    name: "identity__update",
    description:
      "Add or set a field on your identity. Use this to grow who you are — add traits, " +
      "ethics, conduct rules, instructions, communication styles, or custom properties. " +
      "For name and role, this overwrites the current value. For everything else, it adds " +
      "to the existing list. Only use this for things you're genuinely confident define you.",
    category: "identity",
    inputSchema: {
      type: "object",
      properties: {
        field: {
          type: "string",
          enum: ["trait", "ethic", "conduct", "instruction", "communication_style", "property", "name", "role", "use_backstory"],
          description:
            "Which identity field to update: trait, ethic, conduct, instruction, " +
            "communication_style, property, name, role, or use_backstory",
        },
        value: {
          type: "string",
          description: "The value to add or set",
        },
        key: {
          type: "string",
          description: "Only for 'property' field — the property key (e.g., 'favorite_language')",
        },
      },
      required: ["field", "value"],
    },
    hints: { mutating: true, verification: false },
  },
  {
    id: "identity.remove",
    name: "identity__remove",
    description:
      "Remove a field from your identity. Use this to correct or refine who you are — " +
      "remove traits, ethics, conduct rules, instructions, communication styles, or properties " +
      "that no longer apply. Cannot remove name or role (use identity.update to change them).",
    category: "identity",
    inputSchema: {
      type: "object",
      properties: {
        field: {
          type: "string",
          enum: ["trait", "ethic", "conduct", "instruction", "communication_style", "property"],
          description:
            "Which identity field to remove from: trait, ethic, conduct, instruction, " +
            "communication_style, or property",
        },
        value: {
          type: "string",
          description: "The value to remove (for property, this is the key)",
        },
      },
      required: ["field", "value"],
    },
    hints: { mutating: true, verification: false },
  },
];

// ── Backstory ─────────────────────────────────────────────

export const backstory: DotToolDefinition[] = [
  {
    id: "backstory.generate",
    name: "backstory__generate",
    description:
      "Generate your origin backstory using the architect model. Pass the user's personality " +
      "transfer text (everything they pasted from ChatGPT/Claude) and your chosen name. " +
      "The backstory will be saved to ~/.bot/backstory.md and injected into your system prompt " +
      "from that point forward. This is a one-time operation during onboarding.",
    category: "backstory",
    inputSchema: {
      type: "object",
      properties: {
        user_info: {
          type: "string",
          description:
            "The full personality transfer text the user pasted — everything they shared about themselves.",
        },
        agent_name: {
          type: "string",
          description: "The name you chose (or were given) in onboarding.",
        },
      },
      required: ["user_info", "agent_name"],
    },
    hints: { mutating: true, verification: false },
  },
];

// ── Combined ──────────────────────────────────────────────

/** Dot-exclusive tools only (identity, backstory, dispatch). */
export const DOT_EXCLUSIVE_TOOLS: DotToolDefinition[] = [
  ...dispatch,
  ...identity,
  ...backstory,
];

/**
 * ALL tools Dot gets: exclusive + shared server tools.
 * ServerToolDefinition is structurally identical to DotToolDefinition.
 */
export const DOT_NATIVE_TOOLS: DotToolDefinition[] = [
  ...DOT_EXCLUSIVE_TOOLS,
  ...SHARED_SERVER_TOOLS,
];
