/**
 * Git Tool Definitions
 */

import type { DotBotTool } from "../../memory/types.js";

export const gitTools: DotBotTool[] = [
  {
    id: "git.run",
    name: "git_run",
    description: "Run a git command with automatic long timeouts and safety checks. Handles clone, pull, push, fetch, checkout, branch, status, log, add, commit, merge, diff, remote, stash, and more. Blocks dangerous operations like force-push and deleting main/master. Use this instead of shell.powershell for git operations.",
    source: "core",
    category: "git",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "git subcommand: clone, pull, push, fetch, checkout, branch, status, log, add, commit, merge, diff, remote, stash, etc." },
        args: { type: "string", description: "Arguments for the git subcommand (e.g., branch name, remote URL, file paths, flags)" },
        working_directory: { type: "string", description: "Directory to run in (default: current directory)" },
        timeout_seconds: { type: "number", description: "Max seconds (default: 120, max: 600)" },
      },
      required: ["command"],
    },
    annotations: { destructiveHint: true },
  },
];
