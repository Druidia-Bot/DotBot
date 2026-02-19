/**
 * Shared Server Tool Definitions
 *
 * Tools available to ALL server-side callers: Dot, pipeline agents,
 * and any future execution context. These are server-executed tools
 * whose handlers live in tool-loop/handlers/.
 *
 * Dot-exclusive tools (identity, backstory, dispatch) live separately
 * in dot/tools/definitions/dot-native.ts.
 */

// ── Types ────────────────────────────────────────────────

/** Behavior hints consumed by the tool loop's verification/mutation tracking. */
export interface ServerToolHints {
  /** Tool performs state mutations (writes, creates, deletes). */
  mutating?: boolean;
  /** Tool is a read-only verification/inspection call. */
  verification?: boolean;
}

/** Category groupings for shared server tools. */
export type ServerToolCategory =
  | "skill"
  | "logs"
  | "agent"
  | "search"
  | "tools";

/**
 * Declarative definition for a shared server tool.
 * Same shape as DotToolDefinition — both convert to LLM ToolDefinition
 * via the same toNativeTools() function.
 */
export interface ServerToolDefinition {
  /** Canonical tool ID using dot notation (e.g., "skill.search"). */
  id: string;
  /** LLM function name (dots replaced with __), e.g., "skill__search". */
  name: string;
  /** LLM-facing description of what the tool does. */
  description: string;
  /** Logical grouping for registry lookups. */
  category: ServerToolCategory;
  /** JSON Schema for the tool's input parameters. */
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
  /** Behavior hints for the verification loop. */
  hints: ServerToolHints;
}

// ── Skills ────────────────────────────────────────────────

export const skills: ServerToolDefinition[] = [
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

// ── Logs ──────────────────────────────────────────────────

export const logs: ServerToolDefinition[] = [
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

export const agent: ServerToolDefinition[] = [
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

// ── Search (server-side, xAI Responses API) ─────────────

export const search: ServerToolDefinition[] = [
  {
    id: "search.web",
    name: "search__web",
    description:
      "Unified web search — searches both the web and X/Twitter in parallel using Grok, " +
      "then merges the results. This is the preferred search tool for most queries. " +
      "If the xAI key is not configured, returns a fallback message suggesting search.brave or search.ddg_instant.",
    category: "search",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
        include_x: {
          type: "boolean",
          description: "Include X/Twitter results (default true). Set false for purely web-only searches.",
        },
      },
      required: ["query"],
    },
    hints: { mutating: false, verification: true },
  },
  {
    id: "search.grok_web",
    name: "search__grok_web",
    description:
      "Search the web using Grok's built-in web search. Returns a synthesized answer " +
      "with source citations. Use search.web instead for combined web + X results.",
    category: "search",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
      },
      required: ["query"],
    },
    hints: { mutating: false, verification: true },
  },
  {
    id: "search.grok_x",
    name: "search__grok_x",
    description:
      "Search X/Twitter posts using Grok's built-in X search. Returns a synthesized " +
      "answer with links to relevant posts. Best for: recent news, trending topics, " +
      "public opinions, real-time events.",
    category: "search",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
      },
      required: ["query"],
    },
    hints: { mutating: false, verification: true },
  },
];

// ── Tools (discovery + execution) ────────────────────────

export const tools: ServerToolDefinition[] = [
  {
    id: "tools.list_tools",
    name: "tools__list_tools",
    description:
      "List ALL available tools across every source: local-agent tools (filesystem, shell, " +
      "search, http, etc.), server-side tools (memory, knowledge, search.grok_web, imagegen, " +
      "premium), and shared server tools (skills, logs, agent, search). " +
      "Optionally filter by category or source. Use this to discover what you can do.",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Filter by category (e.g. 'search', 'filesystem', 'memory'). Omit for all.",
        },
        source: {
          type: "string",
          description: "Filter by source: 'core', 'api', 'mcp', 'custom', 'server', 'dot-native'. Omit for all.",
        },
      },
    },
    hints: { mutating: false, verification: true },
  },
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

// ── Result Navigation (collection browsing) ──────────────

export const resultNav: ServerToolDefinition[] = [
  {
    id: "result.overview",
    name: "result__overview",
    description:
      "Re-generate the summary table for a collection. Use this when the original overview " +
      "has scrolled out of context, or to view different fields. Pass a collectionId from a " +
      "previous MCP tool result.",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        collectionId: {
          type: "string",
          description: "The collection ID (e.g., 'col_abc123') from a previous tool result",
        },
        fields: {
          type: "array",
          description: "Optional: specific fields to show instead of the default summary fields",
          items: { type: "string" },
        },
      },
      required: ["collectionId"],
    },
    hints: { mutating: false, verification: true },
  },
  {
    id: "result.get",
    name: "result__get",
    description:
      "Retrieve full data for a specific item in a collection by its index. " +
      "Large items are automatically truncated with noise fields omitted — use the 'fields' " +
      "parameter to request specific fields if needed.",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        collectionId: {
          type: "string",
          description: "The collection ID from a previous tool result",
        },
        index: {
          type: "number",
          description: "The item index (0-based, from the overview table)",
        },
        fields: {
          type: "array",
          description: "Optional: specific fields to include (e.g., ['payload', 'body'])",
          items: { type: "string" },
        },
      },
      required: ["collectionId", "index"],
    },
    hints: { mutating: false, verification: true },
  },
  {
    id: "result.filter",
    name: "result__filter",
    description:
      "Filter items in a collection by a field value. Returns matching items with summary " +
      "fields. Operators: 'contains' (substring match), 'equals', 'not_equals', 'gt', 'lt'.",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        collectionId: {
          type: "string",
          description: "The collection ID from a previous tool result",
        },
        field: {
          type: "string",
          description: "Field to filter on (e.g., 'status', 'payload.headers[From]')",
        },
        operator: {
          type: "string",
          description: "Filter operator: 'contains', 'equals', 'not_equals', 'gt', 'lt'",
          enum: ["contains", "equals", "not_equals", "gt", "lt"],
        },
        value: {
          type: "string",
          description: "Value to compare against",
        },
        fields: {
          type: "array",
          description: "Optional: fields to show in the results table",
          items: { type: "string" },
        },
      },
      required: ["collectionId", "field", "operator", "value"],
    },
    hints: { mutating: false, verification: true },
  },
  {
    id: "result.query",
    name: "result__query",
    description:
      "Run a JSONPath-like expression against a collection. Supports field projection, " +
      "slicing, filtering, and aggregation. Examples:\n" +
      "  [*].name                — all names\n" +
      "  [0:5].name,email        — first 5 items, name + email\n" +
      "  [?status==\"active\"]     — filter by field value\n" +
      "  [?score>7].name         — filter then project\n" +
      "  [*].status | count      — group and count by status\n" +
      "  [*].price | sum         — sum all prices\n" +
      "  .length                 — item count\n" +
      "Pipe operators: unique, count, sum, avg, min, max.",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        collectionId: {
          type: "string",
          description: "The collection ID from a previous tool result",
        },
        expression: {
          type: "string",
          description: "JSONPath-like expression (e.g., '[*].name', '[?status==\"active\"].email | unique')",
        },
      },
      required: ["collectionId", "expression"],
    },
    hints: { mutating: false, verification: true },
  },
];

// ── Combined ──────────────────────────────────────────────

/** All shared server tool definitions — available to Dot AND pipeline agents. */
export const SHARED_SERVER_TOOLS: ServerToolDefinition[] = [
  ...skills,
  ...logs,
  ...agent,
  ...search,
  ...tools,
  ...resultNav,
];
