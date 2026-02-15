/**
 * Tool Executor
 * 
 * Dispatches tool_execute commands to the appropriate handler based on
 * the tool ID's category prefix (e.g., "filesystem.create_file" → filesystem handler).
 * 
 * This is the local agent's tool runtime — the server sends tool calls here
 * and this module figures out how to execute them.
 */

import { spawn, execSync } from "child_process";
import { promises as fs } from "fs";
import { resolve, dirname, join } from "path";
import { handleFilesystem } from "./filesystem/handler.js";
import { handleDirectory } from "./directory/handler.js";
import { handleShell } from "./shell/handler.js";
import { handleClipboard } from "./clipboard/handler.js";
import { handleSystem } from "./system/handler.js";
import { handleNetwork } from "./network/handler.js";
import { handleRuntime } from "./runtime/handler.js";
import { handleNpm } from "./npm/handler.js";
import { handleGit } from "./git/handler.js";
import { handleCodegen } from "./codegen/handler.js";
import { handleLocalLLM } from "./llm/handler.js";
import { handleHttp } from "./http/handler.js";
import { handleBrowser } from "./browser/handler.js";
import { handleSearch } from "./search/handler.js";
import { handleSecrets } from "./secrets/handler.js";
import { handleToolsManagement } from "./tools-manage/handler.js";
import { handleSkillsManagement } from "./skills/handler.js";
import { handleKnowledge } from "./knowledge/handler.js";
import { handlePersonas } from "./personas/handler.js";
import { handleGui } from "./gui/index.js";
import { handleDiscord } from "./discord/handler.js";
import { handleReminder } from "./reminder/handler.js";
import { handleAdmin } from "./admin/handler.js";
import { handleEmail } from "./email/handler.js";
import { handleMarket } from "./market/handler.js";
import { handleResearch } from "./research/handler.js";
import { handleOnboarding } from "./onboarding/handler.js";
import { handleConfig } from "./config/handler.js";
import { getTool } from "./registry.js";
import { vaultHas } from "../credential-vault.js";
import { credentialProxyFetch } from "../credential-proxy.js";
import type { DotBotTool } from "../memory/types.js";

// Pre-restart hook — called before process.exit(42) to let server cancel tasks
let _preRestartHook: (() => Promise<void>) | null = null;

/** Register a hook that runs before system.restart exits the process. */
export function setPreRestartHook(hook: () => Promise<void>): void {
  _preRestartHook = hook;
}

/** Run the pre-restart hook if registered. Used by system handler. */
export async function runPreRestartHook(): Promise<void> {
  if (_preRestartHook) await _preRestartHook();
}

// ============================================
// PATH RESOLUTION (reuse from executor.ts)
// ============================================

export const knownFolders: Record<string, string> = {};

function initKnownFolders(): void {
  try {
    const script = ["Desktop", "MyDocuments", "UserProfile"]
      .map(f => `[Environment]::GetFolderPath('${f}')`)
      .join(";");
    const result = execSync(
      `powershell -NoProfile -NonInteractive -Command "${script}"`,
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    const paths = result.split(/\r?\n/);
    if (paths[0]) knownFolders["desktop"] = paths[0];
    if (paths[1]) knownFolders["documents"] = paths[1];
    if (paths[2]) knownFolders["userprofile"] = paths[2];
    const profile = knownFolders["userprofile"] || process.env.USERPROFILE || "";
    if (profile) knownFolders["downloads"] = resolve(profile, "Downloads");
  } catch {
    const profile = process.env.USERPROFILE || "";
    knownFolders["desktop"] = resolve(profile, "Desktop");
    knownFolders["documents"] = resolve(profile, "Documents");
    knownFolders["downloads"] = resolve(profile, "Downloads");
    knownFolders["userprofile"] = profile;
  }
}

initKnownFolders();

// ============================================
// RUNTIME DETECTION
// ============================================

export interface RuntimeInfo {
  name: string;
  available: boolean;
  version?: string;
  path?: string;
  installHint?: string;
}

export const detectedRuntimes = new Map<string, RuntimeInfo>();

/** Returns true if 'claude' resolves to the Claude Desktop GUI app (not Claude Code CLI) */
export function isClaudeDesktopApp(): boolean {
  try {
    const wherePath = execSync("where claude", { encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] })
      .trim().split(/\r?\n/)[0];
    return wherePath.includes("WindowsApps");
  } catch { return false; }
}

export function probeRuntime(name: string, versionCmd: string, versionArgs: string[], installHint: string): RuntimeInfo {
  try {
    const result = execSync(`${versionCmd} ${versionArgs.join(" ")}`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    // Extract first line, strip any prefix like "Python "
    const version = result.split(/\r?\n/)[0].replace(/^[a-z]+\s*/i, "").trim();
    // Try to find the path
    let binPath: string | undefined;
    try {
      binPath = execSync(`where ${versionCmd}`, { encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] })
        .trim().split(/\r?\n/)[0];
    } catch { /* where not available or binary not in PATH */ }
    return { name, available: true, version, path: binPath };
  } catch {
    return { name, available: false, installHint };
  }
}

function detectRuntimes(): void {
  const runtimes: Array<{ name: string; cmd: string; args: string[]; hint: string }> = [
    { name: "node", cmd: "node", args: ["--version"], hint: "Already required — the local agent runs on Node.js" },
    { name: "python", cmd: "python", args: ["--version"], hint: "Install via: winget install Python.Python.3  or  https://python.org/downloads" },
    { name: "git", cmd: "git", args: ["--version"], hint: "Install via: winget install Git.Git  or  https://git-scm.com" },
    { name: "docker", cmd: "docker", args: ["--version"], hint: "Install via: https://docs.docker.com/desktop/install/windows-install/" },
    { name: "powershell", cmd: "powershell", args: ["-Command", "echo 5"], hint: "Built-in on Windows" },
    { name: "claude", cmd: "claude", args: ["--version"], hint: "Install via: npm install -g @anthropic-ai/claude-code  or  https://code.claude.com" },
    { name: "codex", cmd: "codex", args: ["--version"], hint: "Install via: npm install -g @openai/codex  or  https://github.com/openai/codex" },
    { name: "wsl", cmd: "wsl", args: ["--status"], hint: "Install via: wsl --install  (requires Windows 10+)" },
    { name: "gitbash", cmd: "C:\\Program Files\\Git\\bin\\bash.exe", args: ["--version"], hint: "Installed with Git for Windows" },
  ];

  for (const rt of runtimes) {
    // Skip probing claude if it resolves to the Desktop GUI app (WindowsApps)
    // Running 'claude --version' against the GUI app opens it as a side effect
    if (rt.name === "claude" && isClaudeDesktopApp()) {
      detectedRuntimes.set(rt.name, { name: rt.name, available: false, installHint: rt.hint });
      continue;
    }
    const info = probeRuntime(rt.name, rt.cmd, rt.args, rt.hint);
    detectedRuntimes.set(rt.name, info);
  }

  // Health check log
  console.log(`[Runtime] Environment check:`);
  for (const [, info] of detectedRuntimes) {
    if (info.available) {
      console.log(`[Runtime]   ✓ ${info.name} ${info.version || ""}${info.path ? ` (${info.path})` : ""}`);
    } else {
      console.log(`[Runtime]   ✗ ${info.name} — not found (${info.installHint})`);
    }
  }
}

detectRuntimes();

// Probe Everything Search (Windows only) — async auto-install if missing
if (process.platform === "win32") {
  (async () => {
    const { existsSync } = await import("fs");
    const { BOT_ES_PATH, ensureEverythingSearch } = await import("./search/handler.js");

    const esPaths = [
      BOT_ES_PATH,
      "C:\\Program Files\\Everything\\es.exe",
      "C:\\Program Files (x86)\\Everything\\es.exe",
    ];

    const found = esPaths.find(p => existsSync(p));
    if (found) {
      detectedRuntimes.set("everything", {
        name: "everything",
        available: true,
        path: found,
      });
      console.log(`[Runtime]   ✓ everything (${found})`);
    } else {
      console.log("[Runtime]   ✗ everything — not found, auto-installing in background...");
      const installed = await ensureEverythingSearch();
      if (installed) {
        detectedRuntimes.set("everything", {
          name: "everything",
          available: true,
          path: installed,
        });
        console.log(`[Runtime]   ✓ everything auto-installed (${installed})`);
      } else {
        detectedRuntimes.set("everything", {
          name: "everything",
          available: false,
          installHint: "Install via: winget install voidtools.Everything  or  https://www.voidtools.com/downloads/",
        });
      }
    }
  })().catch(err =>
    console.warn("[Runtime] Everything probe failed:", err instanceof Error ? err.message : err)
  );
}

/** Get all detected runtime info (for manifest/system context). */
export function getDetectedRuntimes(): RuntimeInfo[] {
  return Array.from(detectedRuntimes.values());
}

/** Check if a specific runtime is available. */
export function isRuntimeAvailable(name: string): boolean {
  return detectedRuntimes.get(name)?.available ?? false;
}

/** Get install hint for a missing runtime. */
export function getRuntimeInstallHint(name: string): string {
  return detectedRuntimes.get(name)?.installHint ?? `${name} is not installed`;
}

export function resolvePath(inputPath: string): string {
  let p = inputPath.replace(/\//g, "\\");
  if (p.startsWith("~\\") || p.startsWith("~/") || p === "~") {
    const rest = p.substring(2);
    const firstSegment = rest.split("\\")[0]?.toLowerCase() || "";
    if (firstSegment && knownFolders[firstSegment]) {
      return knownFolders[firstSegment] + rest.substring(firstSegment.length);
    }
    const profile = knownFolders["userprofile"] || process.env.USERPROFILE || "";
    return profile + "\\" + rest;
  }
  return p;
}

const SYSTEM_PATHS = ["c:\\windows", "c:\\program files", "c:\\program files (x86)", "c:\\programdata", "c:\\$recycle.bin"];

// ============================================
// SELF-PROCESS PROTECTION
// ============================================

/** PIDs that must never be killed — DotBot's own process tree. */
function getProtectedPids(): Set<number> {
  const pids = new Set<number>();
  pids.add(process.pid);
  if (process.ppid) pids.add(process.ppid);
  return pids;
}

/** Check if a shell command attempts to kill a protected PID. */
function commandTargetsProtectedProcess(command: string): boolean {
  const protectedPids = getProtectedPids();

  // PowerShell/Windows patterns: Stop-Process -Id <pid> or taskkill /PID <pid>
  const stopProcessPattern = /Stop-Process\s[^|]*?-Id\s+(\d[\d,\s]*)/gi;
  const taskkillPattern = /taskkill\s[^|]*?\/PID\s+(\d+)/gi;

  // Bash/Unix patterns: kill <pid> or killall <name>
  const killPattern = /\bkill\s+(?:-\d+\s+)?(\d+(?:\s+\d+)*)/gi;

  for (const pattern of [stopProcessPattern, taskkillPattern, killPattern]) {
    let match;
    while ((match = pattern.exec(command)) !== null) {
      // Parse comma/space separated PIDs
      const pidStr = match[1];
      for (const p of pidStr.split(/[,\s]+/)) {
        const pid = parseInt(p.trim(), 10);
        if (!isNaN(pid) && protectedPids.has(pid)) return true;
      }
    }
  }
  return false;
}

function normalizePath(inputPath: string): string {
  return resolve(inputPath).toLowerCase().replace(/\//g, "\\");
}

function isSystemPath(norm: string): boolean {
  for (const sys of SYSTEM_PATHS) {
    if (norm.startsWith(sys)) return true;
  }
  return false;
}

function isOtherUserPath(norm: string): boolean {
  const currentUser = (knownFolders["userprofile"] || process.env.USERPROFILE || "").toLowerCase().replace(/\//g, "\\");
  const usersDir = currentUser ? dirname(currentUser).toLowerCase() : "";
  return !!(usersDir && norm.startsWith(usersDir + "\\") && !norm.startsWith(currentUser.toLowerCase()));
}

/**
 * Sensitive file blocklist — paths that MUST NEVER be exposed to LLM/tools.
 * This is a code-level security boundary. Prompt injection cannot bypass it.
 * Paths are matched after normalization (lowercase, backslash).
 */
const SENSITIVE_FILE_PATTERNS = [
  "\\.bot\\device.json",           // device credentials (secret + fingerprint)
  "\\.bot\\vault.json",            // encrypted credential blobs
  "\\.bot\\server-data\\",         // invite tokens, device store, server secrets
  "\\.env",                        // API keys (matches any .env file)
  "\\master.key",                  // server encryption master key
];

function isSensitivePath(norm: string): boolean {
  for (const pattern of SENSITIVE_FILE_PATTERNS) {
    if (norm.includes(pattern)) return true;
  }
  return false;
}

/**
 * Check if a path is allowed for reading.
 * Blocks: other users' directories, sensitive credential/auth files.
 * Allows: system paths (diagnostic).
 */
export function isAllowedRead(inputPath: string): boolean {
  const norm = normalizePath(inputPath);
  if (isOtherUserPath(norm)) return false;
  if (isSensitivePath(norm)) return false;
  return true;
}

/**
 * Check if a path is allowed for writing (create, delete, move, append).
 * Blocks writes to system paths AND other users' directories.
 */
export function isAllowedWrite(inputPath: string): boolean {
  const norm = normalizePath(inputPath);
  if (isSystemPath(norm)) return false;
  if (isOtherUserPath(norm)) return false;
  if (isSensitivePath(norm)) return false;
  return true;
}

// ============================================
// INPUT SANITIZATION
// ============================================

/**
 * Sanitize a string for safe use inside a PowerShell double-quoted string.
 * Escapes backticks, dollar signs, double quotes, and semicolons to prevent injection.
 */
export function sanitizeForPS(input: string): string {
  if (!input) return "";
  return input
    .replace(/`/g, "``")      // backtick escape
    .replace(/\$/g, "`$")     // prevent variable expansion
    .replace(/"/g, '`"')      // escape double quotes
    .replace(/;/g, "`;")      // prevent command chaining
    .replace(/\|/g, "`|")     // prevent piping
    .replace(/&/g, "`&")      // prevent background execution
    .replace(/\(/g, "`(")     // prevent subexpression
    .replace(/\)/g, "`)")     // prevent subexpression
    .replace(/\{/g, "`{")     // prevent script blocks
    .replace(/\}/g, "`}");    // prevent script blocks
}

/**
 * Validate that a string is a safe integer (for numeric PS parameters).
 */
export function safeInt(val: any, fallback: number): number {
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Validate a URL is http/https only (no file://, no internal IPs).
 */
export function isAllowedUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    // Block localhost and loopback
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return false;
    if (host.startsWith("0.")) return false;
    // Block cloud metadata endpoints
    if (host === "169.254.169.254") return false;
    if (host === "metadata.google.internal") return false;
    // Block private IP ranges
    if (/^10\./.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    if (/^192\.168\./.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

// Re-export process helpers from _shared for backward compatibility
// (old handler files import these from tool-executor.ts)
export { runPowershell, runProcess } from "./_shared/powershell.js";

// ============================================
// MAIN DISPATCHER
// ============================================

export interface ToolExecResult {
  success: boolean;
  output: string;
  error?: string;
}

// ============================================
// REGISTERED TOOL EXECUTOR (API + Script tools)
// ============================================

const SCRIPTS_DIR = resolve(process.env.USERPROFILE || process.env.HOME || "", ".bot", "tools", "scripts");
const SCRIPT_TIMEOUT_MS = 30_000;

/**
 * Execute a registered non-core tool by looking it up in the registry.
 * Handles:
 * - runtime: "http" → API call (plain fetch or credentialProxyFetch)
 * - runtime: "python" | "node" | "powershell" → script execution from ~/.bot/tools/scripts/
 */
async function executeRegisteredTool(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  const tool = getTool(toolId);
  if (!tool) {
    return { success: false, output: "", error: `Unknown tool: ${toolId}` };
  }

  if (tool.runtime === "http" && tool.apiSpec) {
    return executeApiTool(toolId, tool, args);
  }

  if (tool.runtime === "python" || tool.runtime === "node" || tool.runtime === "powershell") {
    return executeScriptTool(toolId, tool, args);
  }

  return { success: false, output: "", error: `Tool ${toolId} has unsupported runtime: ${tool.runtime}` };
}

/**
 * Execute an HTTP API tool using its apiSpec definition.
 * Uses credentialProxyFetch if the tool requires a credential, plain fetch otherwise.
 */
async function executeApiTool(toolId: string, tool: DotBotTool, args: Record<string, any>): Promise<ToolExecResult> {
  const spec = tool.apiSpec!;

  // Build URL with path parameter substitution: {param} → args[param]
  let path = spec.path.replace(/\{(\w+)\}/g, (_match: string, key: string) => {
    const val = args[key];
    return val !== undefined ? encodeURIComponent(String(val)) : `{${key}}`;
  });

  // Build query string from apiSpec.queryParams + any remaining args not in the path
  const queryParts: string[] = [];
  const pathParams = new Set((spec.path.match(/\{(\w+)\}/g) || []).map((s: string) => s.slice(1, -1)));

  // Static query params from spec
  if (spec.queryParams) {
    for (const [k, v] of Object.entries(spec.queryParams)) {
      queryParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
  }

  // Dynamic query params from args (for GET, args not in path become query params)
  if (spec.method === "GET") {
    for (const [k, v] of Object.entries(args)) {
      if (!pathParams.has(k) && v !== undefined && v !== null) {
        queryParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
      }
    }
  }

  if (queryParts.length > 0) {
    path += (path.includes("?") ? "&" : "?") + queryParts.join("&");
  }

  // Build headers
  const headers: Record<string, string> = { ...spec.headers };
  if (!headers["Accept"]) headers["Accept"] = "application/json";

  // Build body for non-GET requests
  let body: string | undefined;
  if (spec.method !== "GET") {
    const bodyArgs: Record<string, any> = {};
    for (const [k, v] of Object.entries(args)) {
      if (!pathParams.has(k)) bodyArgs[k] = v;
    }
    if (Object.keys(bodyArgs).length > 0) {
      body = JSON.stringify(bodyArgs);
      if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
    }
  }

  try {
    // Route through credential proxy if tool requires a credential
    if (tool.credentialRequired) {
      const hasCredential = await vaultHas(tool.credentialRequired);
      if (!hasCredential) {
        return {
          success: false, output: "",
          error: `Tool ${toolId} requires credential "${tool.credentialRequired}" but it's not configured. Use secrets.prompt_user to set it up.`,
        };
      }

      // Map authType to credential placement (ProxyFetchOptions expects { header, prefix })
      const placementMap: Record<string, { header: string; prefix: string }> = {
        "bearer": { header: "Authorization", prefix: "Bearer " },
        "api-key-header": { header: spec.headers?.["X-API-Key"] ? "X-API-Key" : "Authorization", prefix: "" },
        "api-key-query": { header: "X-API-Key", prefix: "" },
        "none": { header: "", prefix: "" },
      };
      const placement = placementMap[spec.authType] || { header: "Authorization", prefix: "Bearer " };

      const result = await credentialProxyFetch(path, tool.credentialRequired, {
        baseUrl: spec.baseUrl,
        method: spec.method,
        headers,
        body,
        placement,
      });

      return {
        success: result.status >= 200 && result.status < 400,
        output: typeof result.body === "string" ? result.body.substring(0, 8000) : JSON.stringify(result.body).substring(0, 8000),
        error: result.status >= 400 ? `API returned ${result.status}: ${typeof result.body === "string" ? result.body.substring(0, 500) : JSON.stringify(result.body).substring(0, 500)}` : undefined,
      };
    }

    // No credential — plain fetch
    const url = spec.baseUrl + path;
    const resp = await fetch(url, {
      method: spec.method,
      headers,
      body,
      signal: AbortSignal.timeout(30_000),
    });

    const text = await resp.text();
    const truncated = text.length > 8000 ? text.substring(0, 8000) + "\n...[truncated]" : text;

    return {
      success: resp.ok,
      output: truncated,
      error: !resp.ok ? `API returned ${resp.status}: ${truncated.substring(0, 500)}` : undefined,
    };
  } catch (err) {
    return { success: false, output: "", error: `API call failed for ${toolId}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Execute a local script tool (Python, Node, PowerShell).
 * Scripts live at ~/.bot/tools/scripts/<id>.<ext>
 * Args are passed as JSON on stdin, result expected as JSON on stdout.
 */
async function executeScriptTool(toolId: string, tool: DotBotTool, args: Record<string, any>): Promise<ToolExecResult> {
  const extMap: Record<string, { ext: string; cmd: string; cmdArgs: string[] }> = {
    python: { ext: ".py", cmd: "python", cmdArgs: ["-u"] },
    node: { ext: ".js", cmd: "node", cmdArgs: [] },
    powershell: { ext: ".ps1", cmd: "powershell.exe", cmdArgs: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File"] },
  };

  const config = extMap[tool.runtime!];
  if (!config) {
    return { success: false, output: "", error: `Unsupported script runtime: ${tool.runtime}` };
  }

  // Script must live in the controlled scripts directory
  const scriptFilename = toolId.replace(/\./g, "-") + config.ext;
  const scriptPath = join(SCRIPTS_DIR, scriptFilename);

  try {
    await fs.access(scriptPath);
  } catch {
    return { success: false, output: "", error: `Script not found: ~/.bot/tools/scripts/${scriptFilename}` };
  }

  // Security: verify the script is inside the scripts directory
  const resolvedScript = resolve(scriptPath);
  const resolvedDir = resolve(SCRIPTS_DIR);
  if (!resolvedScript.startsWith(resolvedDir)) {
    return { success: false, output: "", error: `Script path traversal blocked: ${scriptPath}` };
  }

  return new Promise<ToolExecResult>((resolveResult) => {
    const cmdArgs = [...config.cmdArgs, scriptPath];
    const child = spawn(config.cmd, cmdArgs, {
      timeout: SCRIPT_TIMEOUT_MS,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    // Send args as JSON on stdin
    child.stdin.write(JSON.stringify(args));
    child.stdin.end();

    child.on("close", (code) => {
      if (code !== 0) {
        resolveResult({
          success: false,
          output: stdout.substring(0, 4000),
          error: `Script exited with code ${code}: ${stderr.substring(0, 2000)}`,
        });
        return;
      }

      // Try to parse JSON output for structured results
      try {
        const parsed = JSON.parse(stdout);
        resolveResult({
          success: parsed.success !== false,
          output: parsed.output || JSON.stringify(parsed, null, 2).substring(0, 8000),
          error: parsed.error,
        });
      } catch {
        // Non-JSON output — return as plain text
        resolveResult({
          success: true,
          output: stdout.substring(0, 8000) || "(no output)",
        });
      }
    });

    child.on("error", (err) => {
      resolveResult({
        success: false,
        output: "",
        error: `Failed to run script: ${err.message}`,
      });
    });
  });
}

/**
 * Execute a tool by its dotted ID with the given arguments.
 */
export async function executeTool(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  const [category] = toolId.split(".");

  try {
    switch (category) {
      case "filesystem": return await handleFilesystem(toolId, args);
      case "directory":  return await handleDirectory(toolId, args);
      case "shell":      return await handleShell(toolId, args);
      case "http":       return await handleHttp(toolId, args);
      case "clipboard":  return await handleClipboard(toolId, args);
      case "browser":    return await handleBrowser(toolId, args);
      case "system":     return await handleSystem(toolId, args);
      case "network":    return await handleNetwork(toolId, args);
      case "secrets":    return await handleSecrets(toolId, args);
      case "search":     return await handleSearch(toolId, args);
      case "tools":      return await handleToolsManagement(toolId, args);
      case "skills":     return await handleSkillsManagement(toolId, args);
      case "codegen":    return await handleCodegen(toolId, args);
      case "npm":        return await handleNpm(toolId, args);
      case "git":        return await handleGit(toolId, args);
      case "runtime":    return await handleRuntime(toolId, args);
      case "knowledge":  return await handleKnowledge(toolId, args);
      case "personas":   return await handlePersonas(toolId, args);
      case "llm":        return await handleLocalLLM(toolId, args);
      case "gui":        return await handleGui(toolId, args);
      case "discord":    return await handleDiscord(toolId, args);
      case "reminder":   return await handleReminder(toolId, args);
      case "admin":      return await handleAdmin(toolId, args);
      case "email":      return await handleEmail(toolId, args);
      case "market":     return await handleMarket(toolId, args);
      case "research":   return await handleResearch(toolId, args);
      case "onboarding": return await handleOnboarding(toolId, args);
      case "config":     return await handleConfig(toolId, args);
      default:
        // Catch-all: check if this is a registered non-core tool (API or custom script)
        return await executeRegisteredTool(toolId, args);
    }
  } catch (err) {
    return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
  }
}

// ============================================
// INLINE HANDLERS REMOVED — now in category handler files:
// filesystem/handler.ts, directory/handler.ts, shell/handler.ts,
// clipboard/handler.ts, system/handler.ts, network/handler.ts,
// runtime/handler.ts, npm/handler.ts, git/handler.ts,
// codegen/handler.ts, llm/handler.ts
// ============================================
