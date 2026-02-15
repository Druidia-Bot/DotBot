/**
 * Codegen Tool Handler (Claude Code / OpenAI Codex)
 */

import { spawn } from "child_process";
import type { ToolExecResult } from "../_shared/types.js";
import { resolvePath } from "../_shared/path.js";
import { detectedRuntimes, isRuntimeAvailable } from "../tool-executor.js";

let lastCodegenFailAt = 0;

export async function handleCodegen(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "codegen.status": {
      const claudeInfo = detectedRuntimes.get("claude");
      const codexInfo = detectedRuntimes.get("codex");
      const lines: string[] = [];
      if (claudeInfo?.available) {
        lines.push(`✓ Claude Code: ${claudeInfo.version || "available"} (${claudeInfo.path || "in PATH"})`);
      } else {
        lines.push(`✗ Claude Code: not installed (${claudeInfo?.installHint || "npm install -g @anthropic-ai/claude-code"})`);
      }
      if (codexInfo?.available) {
        lines.push(`✓ OpenAI Codex: ${codexInfo.version || "available"} (${codexInfo.path || "in PATH"})`);
      } else {
        lines.push(`✗ OpenAI Codex: not installed (${codexInfo?.installHint || "npm install -g @openai/codex"})`);
      }
      return { success: true, output: lines.join("\n") };
    }
    case "codegen.execute": {
      const prompt = args.prompt;
      if (!prompt) return { success: false, output: "", error: "prompt is required" };

      // Retry cooldown — prevent immediate re-execution after a timeout
      const now = Date.now();
      const COOLDOWN_MS = 30_000;
      if (lastCodegenFailAt > 0 && now - lastCodegenFailAt < COOLDOWN_MS) {
        const waitSec = Math.ceil((COOLDOWN_MS - (now - lastCodegenFailAt)) / 1000);
        return { success: false, output: "", error: `Codegen recently failed/timed out. Wait ${waitSec}s before retrying, or use manual file tools (filesystem.create_file, filesystem.edit_file) instead.` };
      }

      const workDir = args.working_directory ? resolvePath(args.working_directory) : resolvePath("~/.bot/workspace/dotbot");
      const systemPrompt = args.system_prompt || "";
      const prefer = args.prefer || "";

      // Determine which CLI to use
      const claudeAvailable = isRuntimeAvailable("claude");
      const codexAvailable = isRuntimeAvailable("codex");

      if (!claudeAvailable && !codexAvailable) {
        return {
          success: false, output: "",
          error: "No AI coding agent installed. Install one:\n" +
            "  Claude Code: npm install -g @anthropic-ai/claude-code\n" +
            "  OpenAI Codex: npm install -g @openai/codex\n" +
            "Then restart the agent. Falling back to manual tools (filesystem.edit_file, filesystem.read_lines, directory.grep).",
        };
      }

      const useClaude = prefer === "codex" ? false : prefer === "claude" ? true : claudeAvailable;
      const useCodex = !useClaude;

      if (useClaude && !claudeAvailable) {
        return { success: false, output: "", error: "Claude Code not installed. Use prefer='codex' or install: npm install -g @anthropic-ai/claude-code" };
      }
      if (useCodex && !codexAvailable) {
        return { success: false, output: "", error: "Codex CLI not installed. Use prefer='claude' or install: npm install -g @openai/codex" };
      }

      // Build command
      const agentName = useClaude ? "Claude Code" : "Codex";
      let cmd: string;
      let cmdArgs: string[];

      if (useClaude) {
        // claude -p reads prompt from stdin when no positional arg given
        cmdArgs = ["-p", "--output-format", "text", "--no-session-persistence", "--dangerously-skip-permissions"];
        if (systemPrompt) {
          cmdArgs.push("--system-prompt", systemPrompt);
        }
        // Prompt piped via stdin below — NOT as arg (avoids DEP0190 + shell escaping)
        cmd = detectedRuntimes.get("claude")?.path || "claude";
      } else {
        // codex exec --full-auto — prompt piped via stdin
        cmdArgs = ["exec", "--full-auto", "-C", workDir];
        if (systemPrompt) {
          cmdArgs.push("-c", `system_prompt="${systemPrompt}"`);
        }
        // Prompt piped via stdin below
        cmd = detectedRuntimes.get("codex")?.path || "codex";
      }

      // 10-minute timeout — complex tasks (building sites, full-project analysis) need time
      const CODEGEN_TIMEOUT_MS = 600_000;

      console.log(`[Codegen] Starting ${agentName} in ${workDir} (timeout: ${CODEGEN_TIMEOUT_MS / 60_000}min)`);
      console.log(`[Codegen] Prompt: ${prompt.substring(0, 200)}${prompt.length > 200 ? "..." : ""}`);

      return new Promise((resolveResult) => {
        // Build full command string for shell execution — avoids DEP0190 warning
        // (passing args array with shell:true triggers Node deprecation warning)
        const fullCmd = [cmd, ...cmdArgs].join(" ");
        const proc = spawn(fullCmd, [], {
          cwd: workDir,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, CI: "true" },
          shell: true, // Required on Windows — .cmd files need shell interpretation
        });
        let stdout = "";
        let stderr = "";
        let lastProgressAt = Date.now();
        let lineCount = 0;
        let resolved = false;

        // Pipe prompt via stdin instead of command-line arg
        // Fixes DEP0190 warning and avoids shell escaping issues
        if (proc.stdin) {
          proc.stdin.write(prompt);
          proc.stdin.end();
        }

        proc.stdout.on("data", (d: Buffer) => {
          const chunk = d.toString();
          stdout += chunk;
          lineCount += (chunk.match(/\n/g) || []).length;

          // Detect interactive prompts and auto-accept via stdin
          const lower = chunk.toLowerCase();
          if (lower.includes("trust this folder") || lower.includes("enter to confirm") || lower.includes("(y/n)")) {
            console.log(`[Codegen] Detected interactive prompt — auto-accepting`);
            try { proc.stdin?.write("y\n"); } catch {}
          }

          // Stream progress to console every 5 seconds so the user sees activity
          if (Date.now() - lastProgressAt > 5000) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            console.log(`[Codegen] ${agentName} working... (${elapsed}s, ${lineCount} lines of output)`);
            lastProgressAt = Date.now();
          }
        });
        proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

        const startTime = Date.now();
        const timer = setTimeout(() => {
          proc.kill("SIGTERM");
          // Give it 5s to clean up, then force kill
          setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          const partialNote = stdout.length > 0
            ? `\n\nPartial output (${stdout.length} chars) was produced — some work may have been completed. Check the working directory.`
            : "";
          console.log(`[Codegen] ${agentName} timed out after ${elapsed}s`);
          lastCodegenFailAt = Date.now();
          resolved = true;
          resolveResult({
            success: false,
            output: stdout.substring(0, 8000),
            error: `${agentName} timed out after ${Math.round(CODEGEN_TIMEOUT_MS / 60_000)} minutes. ` +
              `Try breaking the task into smaller pieces (e.g., scaffold first, then add components one at a time). ` +
              `DO NOT call codegen.execute again — use manual file tools instead.${partialNote}`,
          });
        }, CODEGEN_TIMEOUT_MS);

        proc.on("close", (code: number | null) => {
          clearTimeout(timer);
          if (resolved) return; // Timeout already resolved this promise
          resolved = true;
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          // Truncate output if very large (protect context window)
          const maxOutput = 8000;
          let output = stdout.trim();
          if (output.length > maxOutput) {
            output = output.substring(0, maxOutput) + `\n\n... (truncated, ${stdout.length} total chars)`;
          }
          if (code === 0) {
            console.log(`[Codegen] ${agentName} completed successfully in ${elapsed}s`);
            resolveResult({ success: true, output: output || "(completed with no output)" });
          } else {
            console.log(`[Codegen] ${agentName} exited with code ${code} after ${elapsed}s`);
            lastCodegenFailAt = Date.now();
            resolveResult({ success: false, output, error: stderr || `Exit code ${code}` });
          }
        });

        proc.on("error", (err: Error) => {
          clearTimeout(timer);
          if (resolved) return;
          resolved = true;
          lastCodegenFailAt = Date.now();
          console.log(`[Codegen] Failed to start ${cmd}: ${err.message}`);
          resolveResult({ success: false, output: "", error: `Failed to start ${cmd}: ${err.message}` });
        });
      });
    }
    default:
      return { success: false, output: "", error: `Unknown codegen tool: ${toolId}` };
  }
}
