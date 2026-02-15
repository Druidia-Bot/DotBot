/**
 * Shell Tool Handler
 */

import { spawn, execSync } from "child_process";
import { promises as fs } from "fs";
import { join } from "path";
import type { ToolExecResult } from "../_shared/types.js";
import { resolvePath } from "../_shared/path.js";
import { commandTargetsProtectedProcess, matchesDangerousPattern, matchesDangerousBashPattern } from "../_shared/security.js";
import { safeInt, runPowershell, runProcess } from "../_shared/powershell.js";
import { isRuntimeAvailable, getRuntimeInstallHint } from "../tool-executor.js";

export async function handleShell(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "shell.powershell": {
      if (commandTargetsProtectedProcess(args.command)) {
        return { success: false, output: "", error: "Blocked: this command would kill DotBot's own process. The local agent and server must not be terminated by tool calls." };
      }
      const dangerousReason = matchesDangerousPattern(args.command);
      if (dangerousReason) {
        return { success: false, output: "", error: `Blocked: command rejected for safety (${dangerousReason}). This operation is too destructive to run via tool call.` };
      }
      const timeoutMs = args.timeout_seconds ? Math.min(safeInt(args.timeout_seconds, 30), 600) * 1000 : 30_000;
      return runPowershell(args.command, timeoutMs);
    }
    case "shell.node":
      // SECURITY NOTE: Node.js scripts can call require('child_process').exec() to bypass all command checks.
      // This tool should only be used for trusted computation, not arbitrary LLM-generated code.
      // Consider limiting this tool's availability in high-risk scenarios.
      if (!isRuntimeAvailable("node")) {
        return { success: false, output: "", error: `Node.js is not available. ${getRuntimeInstallHint("node")}` };
      }
      return runProcess("node", ["-e", args.script], 30_000);
    case "shell.bash": {
      // SECURITY: Check for protected process targeting
      if (commandTargetsProtectedProcess(args.command)) {
        return { success: false, output: "", error: "Blocked: this command would kill DotBot's own process. The local agent and server must not be terminated by tool calls." };
      }
      // SECURITY: Check for dangerous bash patterns
      const dangerousBashReason = matchesDangerousBashPattern(args.command);
      if (dangerousBashReason) {
        return { success: false, output: "", error: `Blocked: command rejected for safety (${dangerousBashReason}). This operation is too destructive to run via tool call.` };
      }

      // Auto-detect: prefer WSL, fall back to Git Bash
      const bashTimeout = args.timeout_seconds ? Math.min(safeInt(args.timeout_seconds, 30), 600) * 1000 : 30_000;
      const wslAvailable = isRuntimeAvailable("wsl");
      const gitBashAvailable = isRuntimeAvailable("gitbash");
      if (!wslAvailable && !gitBashAvailable) {
        return { success: false, output: "", error: "No bash shell available. Install WSL (wsl --install) or Git for Windows (https://git-scm.com). Consider using shell.powershell as an alternative." };
      }
      if (wslAvailable) {
        return runProcess("wsl", ["bash", "-c", args.command], bashTimeout);
      }
      // Git Bash
      return runProcess("C:\\Program Files\\Git\\bin\\bash.exe", ["-c", args.command], bashTimeout);
    }
    case "shell.python":
      // SECURITY NOTE: Python scripts can call os.system() or subprocess to bypass all command checks.
      // This tool should only be used for trusted computation, not arbitrary LLM-generated code.
      // Consider limiting this tool's availability in high-risk scenarios.
      if (!isRuntimeAvailable("python")) {
        return { success: false, output: "", error: `Python is not installed. ${getRuntimeInstallHint("python")}. Consider using shell.node or shell.powershell as alternatives.` };
      }
      return runProcess("python", ["-c", args.script], 30_000);
    case "shell.npm_dev_server":
      return handleNpmDevServer(args);
    default:
      return { success: false, output: "", error: `Unknown shell tool: ${toolId}` };
  }
}

export async function handleNpmDevServer(args: Record<string, any>): Promise<ToolExecResult> {
  const projectDir = args.project_directory ? resolvePath(args.project_directory) : "";
  if (!projectDir) return { success: false, output: "", error: "project_directory is required" };

  const doInstall = args.install !== false;
  const script = args.script || "dev";
  const openBrowser = args.open_browser !== false;
  const timeoutSec = Math.min(safeInt(args.timeout_seconds, 60), 300);
  const log: string[] = [];

  // Step 1: npm install
  if (doInstall) {
    log.push("[1/4] Running npm install...");
    const installResult = await runPowershell(
      `Set-Location '${projectDir.replace(/'/g, "''")}'; npm install 2>&1 | Out-String`,
      120_000
    );
    if (!installResult.success) {
      return { success: false, output: log.join("\n"), error: `npm install failed: ${installResult.error || installResult.output}` };
    }
    log.push(`  ✓ npm install completed`);
  }

  // Step 2: Detect port from package.json if not specified
  let port = args.port ? safeInt(args.port, 3000) : 0;
  if (!port) {
    try {
      const pkgJson = await fs.readFile(join(projectDir, "package.json"), "utf-8");
      const pkg = JSON.parse(pkgJson);
      const devScript: string = pkg.scripts?.[script] || "";
      const portMatch = devScript.match(/--port\s+(\d+)|PORT=(\d+)|-p\s+(\d+)/);
      port = portMatch ? parseInt(portMatch[1] || portMatch[2] || portMatch[3]) : 3000;
    } catch {
      port = 3000;
    }
  }
  log.push(`[2/4] Starting npm run ${script} (expecting port ${port})...`);

  // Step 3: Start dev server as a background process
  const devProc = spawn("npm", ["run", script], {
    cwd: projectDir,
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
    detached: true,
  });

  let serverOutput = "";
  devProc.stdout?.on("data", (d: Buffer) => { serverOutput += d.toString(); });
  devProc.stderr?.on("data", (d: Buffer) => { serverOutput += d.toString(); });

  // Unref so the local-agent process doesn't wait for the dev server
  devProc.unref();

  // Step 4: Poll for port to become available
  log.push(`[3/4] Waiting for port ${port}...`);
  const startWait = Date.now();
  let portReady = false;

  while (Date.now() - startWait < timeoutSec * 1000) {
    try {
      const checkResult = await runPowershell(
        `$c = New-Object System.Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1', ${port}); $c.Close(); 'OPEN' } catch { 'CLOSED' }`,
        5_000
      );
      if (checkResult.output.includes("OPEN")) {
        portReady = true;
        break;
      }
    } catch { /* keep trying */ }
    await new Promise(r => setTimeout(r, 2000));
  }

  if (!portReady) {
    const partial = serverOutput.substring(0, 2000);
    log.push(`  ✗ Port ${port} not ready after ${timeoutSec}s`);
    return { success: false, output: log.join("\n") + `\n\nServer output:\n${partial}`, error: `Dev server did not start within ${timeoutSec}s on port ${port}` };
  }

  const elapsed = Math.round((Date.now() - startWait) / 1000);
  log.push(`  ✓ Port ${port} is ready (${elapsed}s)`);

  // Step 5: Open in browser
  const url = `http://localhost:${port}`;
  if (openBrowser) {
    log.push(`[4/4] Opening ${url} in browser...`);
    try {
      execSync(`start "" "${url}"`, { stdio: "ignore", timeout: 5000 });
      log.push(`  ✓ Browser opened`);
    } catch {
      log.push(`  ⚠ Could not open browser automatically. Visit: ${url}`);
    }
  } else {
    log.push(`[4/4] Dev server ready at ${url}`);
  }

  return { success: true, output: log.join("\n") };
}
