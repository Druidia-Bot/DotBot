/**
 * Dot-Native Tool Definitions
 *
 * Declarative data objects for all 14 Dot-native tools.
 * Handlers live separately in ../handlers/.
 *
 * Grouped by category, following the pattern in
 * server/src/tools/definitions/universal.ts.
 */

import type { DotToolDefinition } from "../types.js";

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

// ── Skills ────────────────────────────────────────────────

export const skills: DotToolDefinition[] = [
  {
    id: "skill.search",
    name: "skill__search",
    description:
      "Search for predefined skills that match a task description. Skills are learned " +
      "workflows with step-by-step instructions. If a matching skill exists, you can " +
      "read it and include the instructions in your task.dispatch prompt.",
    category: "skill",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What kind of task or workflow you're looking for",
        },
      },
      required: ["query"],
    },
    hints: { mutating: false, verification: true },
  },
  {
    id: "skill.read",
    name: "skill__read",
    description: "Read the full content of a specific skill by its slug.",
    category: "skill",
    inputSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: "The skill slug (from skill.search results)",
        },
      },
      required: ["slug"],
    },
    hints: { mutating: false, verification: true },
  },
  {
    id: "skill.create",
    name: "skill__create",
    description:
      "Create or update a reusable skill. Skills are saved workflows with step-by-step " +
      "instructions that the system can follow. Use this to save a workflow you've learned, " +
      "a design system, coding conventions, or any behavioral instructions worth reusing.",
    category: "skill",
    inputSchema: {
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
    hints: { mutating: true, verification: false },
  },
  {
    id: "skill.delete",
    name: "skill__delete",
    description: "Delete a skill and its entire directory by slug.",
    category: "skill",
    inputSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: "The skill slug to delete",
        },
      },
      required: ["slug"],
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

// ── Logs ──────────────────────────────────────────────────

export const logs: DotToolDefinition[] = [
  {
    id: "logs.list",
    name: "logs__list",
    description:
      "List available run-log files. Each file covers one day (YYYY-MM-DD.log). " +
      "Logs are auto-pruned after 72 hours. Returns file names, sizes, and last-modified timestamps.",
    category: "logs",
    inputSchema: {
      type: "object",
      properties: {},
    },
    hints: { mutating: false, verification: true },
  },
  {
    id: "logs.read",
    name: "logs__read",
    description:
      "Read entries from a specific day's run-log file. Each entry is a JSON object with a " +
      "'stage' field (intake, receptionist, recruiter, planner, dot-start, dot-complete, error, etc.), " +
      "a 'messageId', and stage-specific data. Use 'tail' to read only the most recent N entries.",
    category: "logs",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "The log filename to read, e.g. '2026-02-16.log'. Get available files from logs.list.",
        },
        tail: {
          type: "number",
          description: "Only return the last N entries (most recent). Omit to read all entries.",
        },
      },
      required: ["filename"],
    },
    hints: { mutating: false, verification: true },
  },
  {
    id: "logs.search",
    name: "logs__search",
    description:
      "Search across all run-log files for entries matching a keyword. Useful for finding errors, " +
      "specific stages, message IDs, or tool names. Returns up to 50 matching entries across all days.",
    category: "logs",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search term (case-insensitive). Examples: 'error', 'dot-complete', a messageId, " +
            "a tool name, or any text that might appear in log entries.",
        },
      },
      required: ["query"],
    },
    hints: { mutating: false, verification: true },
  },
];

// ── Agent ─────────────────────────────────────────────────

export const agent: DotToolDefinition[] = [
  {
    id: "agent.status",
    name: "agent__status",
    description:
      "Check, inspect, or resume dispatched agents. Modes (pick one):\n" +
      "1. read_plan + agent_id: Read plan.json and agent_persona.json from the agent's workspace. " +
      "Use this FIRST when a user asks about a stalled/failed agent — it shows the full plan, completed steps, remaining steps, and original request.\n" +
      "2. resume_agent + agent_id: Directly resume a specific agent regardless of its current disk status (interrupted, failed, etc.). " +
      "Use this when the user explicitly asks to restart/resume an agent.\n" +
      "3. scan_orphaned: Scan ALL workspace folders for orphaned agents and auto-resume any that are resumable.\n" +
      "4. agent_id only: Quick check if a specific agent is actively running right now.\n" +
      "5. No args: List all currently running agents.\n" +
      "Use this BEFORE telling the user a task has stalled or stopped — " +
      "an agent may still be actively executing steps even if workspace files look sparse.",
    category: "agent",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "A specific agent ID (e.g. 'agent_KEV95zjfwdw'). Required for read_plan and resume_agent modes.",
        },
        read_plan: {
          type: "boolean",
          description: "If true (with agent_id), reads plan.json + agent_persona.json from the workspace. Shows full plan details, step progress, and original request.",
        },
        resume_agent: {
          type: "boolean",
          description: "If true (with agent_id), directly resumes the agent by re-entering the pipeline. Works regardless of current disk status (interrupted, failed, etc.).",
        },
        scan_orphaned: {
          type: "boolean",
          description: "If true, scan all workspace folders for orphaned agents and attempt to resume any that have remaining steps.",
        },
      },
    },
    hints: { mutating: false, verification: true },
  },
];

// ── Tools (execute passthrough) ───────────────────────────

export const toolsExecute: DotToolDefinition[] = [
  {
    id: "tools.execute",
    name: "tools__execute",
    description:
      "Execute any tool by its ID. Use this to call tools you discovered via tools.list_tools " +
      "that aren't in your primary tool set. Pass the exact tool ID and its arguments.",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        tool_id: {
          type: "string",
          description: "The exact tool ID to execute (e.g. 'discord.full_setup', 'onboarding.status')",
        },
        args: {
          type: "object",
          description: "Arguments to pass to the tool (varies per tool)",
        },
      },
      required: ["tool_id"],
    },
    hints: { mutating: true, verification: false },
  },
];

// ── Combined ──────────────────────────────────────────────

/** All Dot-native tool definitions. */
export const DOT_NATIVE_TOOLS: DotToolDefinition[] = [
  ...dispatch,
  ...skills,
  ...identity,
  ...backstory,
  ...logs,
  ...agent,
  ...toolsExecute,
];
