/**
 * NPM Tool Definitions
 */

import type { DotBotTool } from "../../memory/types.js";

export const npmTools: DotBotTool[] = [
  {
    id: "npm.run",
    name: "npm_run",
    description: "Run an npm command with automatic long timeouts. Handles install, update, uninstall, run (scripts), init, audit, and any other npm subcommand. Use this instead of shell.powershell for npm operations — it has sensible defaults and won't time out on large installs.",
    source: "core",
    category: "npm",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "npm subcommand: install, update, uninstall, run, init, audit, list, outdated, etc." },
        packages: { type: "string", description: "Space-separated package names (for install/update/uninstall). E.g., '@openai/codex typescript vitest'" },
        args: { type: "string", description: "Extra flags: -g (global), --save-dev, -w (workspace), etc." },
        working_directory: { type: "string", description: "Directory to run in (default: current directory)" },
        timeout_seconds: { type: "number", description: "Max seconds (default: 120, max: 600)" },
      },
      required: ["command"],
    },
    annotations: { destructiveHint: true, mutatingHint: true },
  },
];
