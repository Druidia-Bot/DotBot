/**
 * Shell Tool Definitions
 *
 * Includes workflow tools (npm_dev_server) which have category "shell".
 */

import type { DotBotTool } from "../../memory/types.js";

export const shellTools: DotBotTool[] = [
  {
    id: "shell.powershell",
    name: "run_command",
    description: "Run a PowerShell command on the user's Windows PC. Use for creating directories, moving/copying/renaming files, installing software, and multi-step operations. Prefer a single multi-line script over many separate calls. Default timeout is 30 seconds — use timeout_seconds for long-running commands like npm install, git clone, or builds.",
    source: "core",
    category: "shell",
    executor: "local",
    runtime: "powershell",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "PowerShell command or script to execute" },
        timeout_seconds: { type: "number", description: "Max seconds to wait (default: 30). Use 120-300 for npm install, git clone, builds, or other slow commands." },
      },
      required: ["command"],
    },
    annotations: { destructiveHint: true, mutatingHint: true },
  },
  {
    id: "shell.node",
    name: "run_node",
    description: "Execute a Node.js script. Useful for data processing, JSON manipulation, and API calls.",
    source: "core",
    category: "shell",
    executor: "local",
    runtime: "node",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "JavaScript code to execute with Node.js" },
      },
      required: ["script"],
    },
    annotations: { destructiveHint: true, mutatingHint: true },
  },
  {
    id: "shell.bash",
    name: "run_bash",
    description: "Run a bash command using WSL or Git Bash (auto-detected). Useful for Unix-style commands, developer tools, and cross-platform scripts. Falls back to Git Bash if WSL is not available.",
    source: "core",
    category: "shell",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command or script to execute" },
        timeout_seconds: { type: "number", description: "Max seconds to wait (default: 30, max: 600)" },
      },
      required: ["command"],
    },
    annotations: { destructiveHint: true, mutatingHint: true },
  },
  {
    id: "shell.python",
    name: "run_python",
    description: "Execute a Python script. Useful for data science, automation, and scripting.",
    source: "core",
    category: "shell",
    executor: "local",
    runtime: "python",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "Python code to execute" },
      },
      required: ["script"],
    },
    annotations: { destructiveHint: true, mutatingHint: true },
  },
  {
    id: "shell.npm_dev_server",
    name: "npm_dev_server",
    description: "All-in-one workflow: run `npm install` (or update), start `npm run dev` (or a custom script), wait for the dev server to be ready on a port, then open it in Chrome. Handles the full setup-to-preview cycle in one call.",
    source: "core",
    category: "shell",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        project_directory: { type: "string", description: "Absolute path to the project root (where package.json lives)" },
        install: { type: "boolean", description: "Run npm install first (default: true)" },
        script: { type: "string", description: "npm script to run (default: 'dev'). Can also be 'start', 'serve', etc." },
        port: { type: "number", description: "Port to wait for (default: auto-detect from package.json or 3000)" },
        open_browser: { type: "boolean", description: "Open the URL in Chrome when ready (default: true)" },
        timeout_seconds: { type: "number", description: "Max seconds to wait for server to start (default: 60)" },
      },
      required: ["project_directory"],
    },
    annotations: { destructiveHint: true, mutatingHint: true },
  },
];
