/**
 * Codegen Tool Definitions (Claude Code / OpenAI Codex CLI)
 */

import type { DotBotTool } from "../../memory/types.js";

export const codegenTools: DotBotTool[] = [
  {
    id: "codegen.execute",
    name: "codegen_execute",
    description: "Delegate a task to an installed AI agent (Claude Code or OpenAI Codex CLI). These agents can read, analyze, create, and modify files with full project context — not just coding. Use for: multi-file code changes, building sites/apps, code review, writing documentation, analyzing data files, researching a codebase, refactoring, or any task that benefits from deep filesystem awareness. Requires 'claude' or 'codex' CLI to be installed. Runs non-interactively in the specified working directory.",
    source: "core",
    category: "codegen",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to do — describe the coding task clearly" },
        working_directory: { type: "string", description: "Directory to run in (default: ~/.bot/workspace/dotbot)" },
        system_prompt: { type: "string", description: "Optional system prompt to prepend (e.g., project context, constraints)" },
        prefer: { type: "string", description: "Preferred CLI: 'claude' or 'codex'. If not set, uses whichever is available (claude preferred)." },
      },
      required: ["prompt"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "codegen.status",
    name: "codegen_status",
    description: "Check which AI coding agents (Claude Code, OpenAI Codex CLI) are installed and available on this system.",
    source: "core",
    category: "codegen",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: { readOnlyHint: true },
  },
];
