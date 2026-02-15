/**
 * NPM Tool Handler
 */

import { spawn } from "child_process";
import type { ToolExecResult } from "../_shared/types.js";
import { safeInt } from "../_shared/powershell.js";
import { resolvePath } from "../_shared/path.js";
import { isRuntimeAvailable, getRuntimeInstallHint } from "../tool-executor.js";

export async function handleNpm(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "npm.run": {
      if (!isRuntimeAvailable("node")) {
        return { success: false, output: "", error: `Node.js/npm is not available. ${getRuntimeInstallHint("node")}` };
      }
      const subcommand = args.command;
      if (!subcommand) return { success: false, output: "", error: "command is required (e.g., install, update, run, uninstall)" };

      const timeoutMs = args.timeout_seconds ? Math.min(safeInt(args.timeout_seconds, 120), 600) * 1000 : 120_000;
      const cwd = args.working_directory ? resolvePath(args.working_directory) : process.cwd();

      // Build the npm command arguments
      const npmArgs: string[] = [subcommand];

      // Add packages if provided (for install/update/uninstall)
      if (args.packages) {
        npmArgs.push(...args.packages.trim().split(/\s+/));
      }

      // Add extra flags if provided
      if (args.args) {
        npmArgs.push(...args.args.trim().split(/\s+/));
      }

      // Use shell: true so npm.cmd resolves on Windows
      return new Promise((resolve) => {
        const proc = spawn("npm", npmArgs, {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: timeoutMs,
          shell: true,
          env: { ...process.env },
        });
        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
        proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

        const timer = setTimeout(() => {
          proc.kill();
          resolve({ success: false, output: stdout, error: `npm ${subcommand} timed out after ${timeoutMs / 1000}s. Try a longer timeout_seconds.` });
        }, timeoutMs);

        proc.on("close", (code: number | null) => {
          clearTimeout(timer);
          const output = (stdout + "\n" + stderr).trim();
          if (code === 0) {
            resolve({ success: true, output: output || `npm ${subcommand} completed successfully` });
          } else {
            resolve({ success: false, output: stdout, error: stderr || `npm ${subcommand} failed with exit code ${code}` });
          }
        });

        proc.on("error", (err: Error) => {
          clearTimeout(timer);
          resolve({ success: false, output: "", error: `Failed to run npm: ${err.message}` });
        });
      });
    }
    default:
      return { success: false, output: "", error: `Unknown npm tool: ${toolId}` };
  }
}
