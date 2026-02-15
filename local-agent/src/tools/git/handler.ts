/**
 * Git Tool Handler
 */

import type { ToolExecResult } from "../_shared/types.js";
import { safeInt, runProcess } from "../_shared/powershell.js";
import { resolvePath } from "../_shared/path.js";
import { isRuntimeAvailable, getRuntimeInstallHint } from "../tool-executor.js";

export async function handleGit(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "git.run": {
      if (!isRuntimeAvailable("git")) {
        return { success: false, output: "", error: `Git is not installed. ${getRuntimeInstallHint("git")}` };
      }
      const subcommand = args.command;
      if (!subcommand) return { success: false, output: "", error: "command is required (e.g., clone, pull, push, status)" };

      // Safety checks — block dangerous operations
      const fullArgs = args.args || "";
      if (subcommand === "push" && /--force\b|--force-with-lease\b/.test(fullArgs)) {
        return { success: false, output: "", error: "Force-push is blocked for safety. Remove the --force flag." };
      }
      if (subcommand.startsWith("branch") && /\s+-[dD]\s+/.test(fullArgs) && /\b(main|master)\b/.test(fullArgs)) {
        return { success: false, output: "", error: "Deleting main/master branch is blocked for safety." };
      }

      const timeoutMs = args.timeout_seconds ? Math.min(safeInt(args.timeout_seconds, 120), 600) * 1000 : 120_000;
      const cwd = args.working_directory ? resolvePath(args.working_directory) : process.cwd();

      // Build git arguments
      const gitArgs: string[] = [subcommand];
      if (fullArgs) {
        gitArgs.push(...fullArgs.trim().split(/\s+/));
      }

      return runProcess("git", gitArgs, timeoutMs);
    }
    default:
      return { success: false, output: "", error: `Unknown git tool: ${toolId}` };
  }
}
