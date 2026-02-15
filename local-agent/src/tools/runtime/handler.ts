/**
 * Runtime Tool Handler
 */

import { spawn } from "child_process";
import type { ToolExecResult } from "../_shared/types.js";
import { detectedRuntimes, probeRuntime, isClaudeDesktopApp, isRuntimeAvailable } from "../tool-executor.js";

// Install recipes: how to install/update each runtime on Windows
const INSTALL_RECIPES: Record<string, { winget?: string; npm?: string; fallback: string }> = {
  node:    { winget: "NodeJS.NodeJS.LTS", fallback: "Download from https://nodejs.org" },
  npm:     { fallback: "npm is bundled with Node.js. Install/update Node to get the latest npm, or run: npm install -g npm" },
  python:  { winget: "Python.Python.3", fallback: "Download from https://python.org/downloads" },
  git:     { winget: "Git.Git", fallback: "Download from https://git-scm.com" },
  docker:  { winget: "Docker.DockerDesktop", fallback: "Download from https://docs.docker.com/desktop/install/windows-install/" },
  claude:  { npm: "@anthropic-ai/claude-code", fallback: "npm install -g @anthropic-ai/claude-code" },
  codex:   { npm: "@openai/codex", fallback: "npm install -g @openai/codex" },
};

export async function handleRuntime(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "runtime.check": {
      const name = (args.name || "").toLowerCase().trim();
      if (!name) return { success: false, output: "", error: "name is required (e.g., node, npm, git, python, claude, codex, or 'all')" };

      if (name === "all") {
        // Re-probe everything and return full status
        const lines: string[] = [];
        // Also check npm specifically (not in standard probe list)
        const probes: Array<{ name: string; cmd: string; args: string[] }> = [
          { name: "node", cmd: "node", args: ["--version"] },
          { name: "npm", cmd: "npm", args: ["--version"] },
          { name: "python", cmd: "python", args: ["--version"] },
          { name: "git", cmd: "git", args: ["--version"] },
          { name: "docker", cmd: "docker", args: ["--version"] },
          { name: "claude", cmd: "claude", args: ["--version"] },
          { name: "codex", cmd: "codex", args: ["--version"] },
          { name: "wsl", cmd: "wsl", args: ["--status"] },
        ];
        for (const p of probes) {
          // Skip claude probe if it resolves to the Desktop GUI app
          if (p.name === "claude" && isClaudeDesktopApp()) {
            lines.push(`${p.name.padEnd(12)} ✗ not installed (found Claude Desktop app, not Claude Code CLI)`);
            continue;
          }
          const info = probeRuntime(p.name, p.cmd, p.args, "");
          const status = info.available ? `✓ ${info.version || "available"}` : `✗ not installed`;
          lines.push(`${p.name.padEnd(12)} ${status}`);
        }
        return { success: true, output: lines.join("\n") };
      }

      // Single runtime check
      const probeMap: Record<string, { cmd: string; args: string[] }> = {
        node: { cmd: "node", args: ["--version"] },
        npm: { cmd: "npm", args: ["--version"] },
        python: { cmd: "python", args: ["--version"] },
        git: { cmd: "git", args: ["--version"] },
        docker: { cmd: "docker", args: ["--version"] },
        powershell: { cmd: "powershell", args: ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"] },
        claude: { cmd: "claude", args: ["--version"] },
        codex: { cmd: "codex", args: ["--version"] },
        wsl: { cmd: "wsl", args: ["--status"] },
        gitbash: { cmd: "C:\\Program Files\\Git\\bin\\bash.exe", args: ["--version"] },
      };

      const probe = probeMap[name];
      if (!probe) {
        return { success: false, output: "", error: `Unknown runtime: ${name}. Available: ${Object.keys(probeMap).join(", ")}` };
      }

      // Skip claude probe if it resolves to the Desktop GUI app
      if (name === "claude" && isClaudeDesktopApp()) {
        return { success: true, output: `✗ claude: Claude Desktop app found, but Claude Code CLI is not installed. ${INSTALL_RECIPES.claude?.fallback || ""}` };
      }
      const info = probeRuntime(name, probe.cmd, probe.args, "");
      if (info.available) {
        // Update the cached detection too
        detectedRuntimes.set(name, info);
        return { success: true, output: `✓ ${name}: ${info.version || "available"} (${info.path || "in PATH"})` };
      } else {
        const recipe = INSTALL_RECIPES[name];
        const hint = recipe ? `Install: ${recipe.fallback}` : "Not found in PATH";
        return { success: true, output: `✗ ${name}: not installed. ${hint}` };
      }
    }

    case "runtime.install": {
      const name = (args.name || "").toLowerCase().trim();
      if (!name) return { success: false, output: "", error: "name is required (e.g., node, npm, python, git, claude, codex)" };

      const recipe = INSTALL_RECIPES[name];
      if (!recipe) {
        return { success: false, output: "", error: `No install recipe for '${name}'. Available: ${Object.keys(INSTALL_RECIPES).join(", ")}` };
      }

      const forceUpdate = args.update === true;

      // Check if already installed (unless force update)
      if (!forceUpdate) {
        const probeMap: Record<string, { cmd: string; args: string[] }> = {
          node: { cmd: "node", args: ["--version"] },
          npm: { cmd: "npm", args: ["--version"] },
          python: { cmd: "python", args: ["--version"] },
          git: { cmd: "git", args: ["--version"] },
          docker: { cmd: "docker", args: ["--version"] },
          claude: { cmd: "claude", args: ["--version"] },
          codex: { cmd: "codex", args: ["--version"] },
        };
        const probe = probeMap[name];
        if (probe) {
          const existing = probeRuntime(name, probe.cmd, probe.args, "");
          if (existing.available) {
            return { success: true, output: `${name} is already installed: ${existing.version || "available"}. Use update: true to force update.` };
          }
        }
      }

      // npm-based tools (claude, codex)
      if (recipe.npm) {
        const action = forceUpdate ? "install" : "install";
        const result = await new Promise<ToolExecResult>((resolve) => {
          const proc = spawn("npm", [action, "-g", recipe.npm!], {
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 180_000,
            shell: true,
          });
          let stdout = "";
          let stderr = "";
          proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
          proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
          const timer = setTimeout(() => { proc.kill(); resolve({ success: false, output: stdout, error: `npm install timed out after 180s` }); }, 180_000);
          proc.on("close", (code: number | null) => {
            clearTimeout(timer);
            if (code === 0) {
              resolve({ success: true, output: (stdout + "\n" + stderr).trim() || `${name} installed successfully` });
            } else {
              resolve({ success: false, output: stdout, error: stderr || `npm install failed with exit code ${code}` });
            }
          });
          proc.on("error", (err: Error) => { clearTimeout(timer); resolve({ success: false, output: "", error: err.message }); });
        });

        // Re-probe and update cache if successful
        if (result.success) {
          const probeMap: Record<string, { cmd: string; args: string[] }> = {
            claude: { cmd: "claude", args: ["--version"] },
            codex: { cmd: "codex", args: ["--version"] },
          };
          const probe = probeMap[name];
          if (probe) {
            const info = probeRuntime(name, probe.cmd, probe.args, "");
            detectedRuntimes.set(name, info);
            result.output += `\nVerified: ${info.available ? `✓ ${info.version}` : "✗ not found after install (may need PATH reload)"}`;
          }
        }
        return result;
      }

      // winget-based tools (node, python, git, docker)
      if (recipe.winget) {
        const wingetAction = forceUpdate ? "upgrade" : "install";
        const result = await new Promise<ToolExecResult>((resolve) => {
          const proc = spawn("winget", [wingetAction, "--id", recipe.winget!, "--accept-source-agreements", "--accept-package-agreements", "-e"], {
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 300_000,
            shell: true,
          });
          let stdout = "";
          let stderr = "";
          proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
          proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
          const timer = setTimeout(() => { proc.kill(); resolve({ success: false, output: stdout, error: `winget ${wingetAction} timed out after 300s` }); }, 300_000);
          proc.on("close", (code: number | null) => {
            clearTimeout(timer);
            const output = (stdout + "\n" + stderr).trim();
            if (code === 0) {
              resolve({ success: true, output: output || `${name} ${wingetAction}ed successfully. You may need to restart your terminal for PATH changes.` });
            } else {
              // winget returns non-zero if already installed or no upgrade available — that's OK
              if (output.includes("already installed") || output.includes("No available upgrade")) {
                resolve({ success: true, output: `${name} is already up to date.\n${output}` });
              } else {
                resolve({ success: false, output, error: `winget ${wingetAction} failed. Fallback: ${recipe.fallback}` });
              }
            }
          });
          proc.on("error", (err: Error) => {
            clearTimeout(timer);
            resolve({ success: false, output: "", error: `winget not available: ${err.message}. Fallback: ${recipe.fallback}` });
          });
        });
        return result;
      }

      // npm special case — update npm itself
      if (name === "npm") {
        return new Promise<ToolExecResult>((resolve) => {
          const proc = spawn("npm", ["install", "-g", "npm"], {
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 120_000,
            shell: true,
          });
          let stdout = "";
          let stderr = "";
          proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
          proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
          const timer = setTimeout(() => { proc.kill(); resolve({ success: false, output: stdout, error: "npm self-update timed out" }); }, 120_000);
          proc.on("close", (code: number | null) => {
            clearTimeout(timer);
            if (code === 0) resolve({ success: true, output: (stdout + "\n" + stderr).trim() || "npm updated successfully" });
            else resolve({ success: false, output: stdout, error: stderr || `npm update failed with exit code ${code}` });
          });
          proc.on("error", (err: Error) => { clearTimeout(timer); resolve({ success: false, output: "", error: err.message }); });
        });
      }

      return { success: false, output: "", error: `No automated install method for '${name}'. ${recipe.fallback}` };
    }

    default:
      return { success: false, output: "", error: `Unknown runtime tool: ${toolId}` };
  }
}
