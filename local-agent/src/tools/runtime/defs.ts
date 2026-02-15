/**
 * Runtime Tool Definitions (check/install/update runtimes)
 */

import type { DotBotTool } from "../../memory/types.js";

export const runtimeTools: DotBotTool[] = [
  {
    id: "runtime.check",
    name: "runtime_check",
    description: "Check if a specific runtime or tool is installed and get its version. Re-probes on demand (not cached). Use this before trying to use a tool you're unsure about, or to verify an installation succeeded. Pass 'all' to check everything.",
    source: "core",
    category: "runtime",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Runtime to check: node, npm, python, git, docker, powershell, claude, codex, wsl, gitbash — or 'all' for everything" },
      },
      required: ["name"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "runtime.install",
    name: "runtime_install",
    description: "Install or update a runtime/tool using the best available method for this OS. On Windows uses winget for system tools (node, python, git) and npm for CLI tools (claude, codex). Automatically chooses install vs update based on whether it's already present.",
    source: "core",
    category: "runtime",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "What to install/update: node, npm, python, git, claude, codex" },
        update: { type: "boolean", description: "Force update even if already installed (default: false — installs only if missing)" },
      },
      required: ["name"],
    },
    annotations: { destructiveHint: true },
  },
];
