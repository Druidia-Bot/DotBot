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
import { handleHttp, handleBrowser, handleSearch } from "./tool-handlers-web.js";
import { handleSecrets, handleToolsManagement, handleSkillsManagement } from "./tool-handlers-manage.js";
import { handleKnowledge, handlePersonas } from "./tool-handlers-knowledge.js";
import { handleGui } from "./gui/index.js";
import { handleDiscord } from "./tool-handlers-discord.js";
import { handleReminder } from "./tool-handlers-reminder.js";
import { handleAdmin } from "./tool-handlers-admin.js";
import { handleEmail } from "./tool-handlers-email.js";
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

const detectedRuntimes = new Map<string, RuntimeInfo>();
let lastCodegenFailAt = 0;

function probeRuntime(name: string, versionCmd: string, versionArgs: string[], installHint: string): RuntimeInfo {
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
    { name: "powershell", cmd: "powershell", args: ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], hint: "Built-in on Windows" },
    { name: "claude", cmd: "claude", args: ["--version"], hint: "Install via: npm install -g @anthropic-ai/claude-code  or  https://code.claude.com" },
    { name: "codex", cmd: "codex", args: ["--version"], hint: "Install via: npm install -g @openai/codex  or  https://github.com/openai/codex" },
    { name: "wsl", cmd: "wsl", args: ["--status"], hint: "Install via: wsl --install  (requires Windows 10+)" },
    { name: "gitbash", cmd: "C:\\Program Files\\Git\\bin\\bash.exe", args: ["--version"], hint: "Installed with Git for Windows" },
  ];

  for (const rt of runtimes) {
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
  // Match Stop-Process -Id <pid> or taskkill /PID <pid> patterns
  const stopProcessPattern = /Stop-Process\s[^|]*?-Id\s+(\d[\d,\s]*)/gi;
  const taskkillPattern = /taskkill\s[^|]*?\/PID\s+(\d+)/gi;
  for (const pattern of [stopProcessPattern, taskkillPattern]) {
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
    powershell: { ext: ".ps1", cmd: "powershell.exe", cmdArgs: ["-NoProfile", "-NonInteractive", "-File"] },
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
      default:
        // Catch-all: check if this is a registered non-core tool (API or custom script)
        return await executeRegisteredTool(toolId, args);
    }
  } catch (err) {
    return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
  }
}

// ============================================
// FILESYSTEM HANDLERS
// ============================================

async function handleFilesystem(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  const path = args.path ? resolvePath(args.path) : "";

  switch (toolId) {
    case "filesystem.create_file": {
      if (!isAllowedWrite(path)) return { success: false, output: "", error: `Write access denied: ${path}` };
      const dir = dirname(path);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path, args.content || "", "utf-8");
      return { success: true, output: `Written ${(args.content || "").length} bytes to ${path}` };
    }
    case "filesystem.read_file": {
      if (!isAllowedRead(path)) return { success: false, output: "", error: `Read access denied: ${path}` };
      const stat = await fs.stat(path);
      if (stat.size > 10 * 1024 * 1024) return { success: false, output: "", error: `File too large: ${stat.size} bytes` };
      const content = await fs.readFile(path, "utf-8");
      return { success: true, output: content };
    }
    case "filesystem.read_file_base64": {
      if (!isAllowedRead(path)) return { success: false, output: "", error: `Read access denied: ${path}` };
      const statB64 = await fs.stat(path);
      if (statB64.size > 100 * 1024 * 1024) return { success: false, output: "", error: `File too large for base64 transfer: ${(statB64.size / 1024 / 1024).toFixed(1)} MB (limit 100 MB)` };
      const bufferB64 = await fs.readFile(path);
      return { success: true, output: bufferB64.toString("base64") };
    }
    case "filesystem.upload_file": {
      if (!isAllowedRead(path)) return { success: false, output: "", error: `Read access denied: ${path}` };
      const uploadUrl = args.uploadUrl as string;
      if (!uploadUrl) return { success: false, output: "", error: "Missing required 'uploadUrl' parameter" };
      const statUp = await fs.stat(path);
      if (statUp.size > 100 * 1024 * 1024) return { success: false, output: "", error: `File too large: ${(statUp.size / 1024 / 1024).toFixed(1)} MB (limit 100 MB)` };
      const uploadBuffer = await fs.readFile(path);
      const filename = path.split(/[\\/]/).pop() || "file";
      const formData = new FormData();
      formData.append("file", new Blob([uploadBuffer]), filename);
      formData.append("source", args.source || path);
      const uploadResp = await fetch(uploadUrl, { method: "POST", body: formData, signal: AbortSignal.timeout(300_000) });
      if (!uploadResp.ok) {
        const errText = await uploadResp.text();
        return { success: false, output: "", error: `Upload failed (${uploadResp.status}): ${errText}` };
      }
      const uploadResult = await uploadResp.text();
      return { success: true, output: uploadResult };
    }
    case "filesystem.append_file": {
      if (!isAllowedWrite(path)) return { success: false, output: "", error: `Write access denied: ${path}` };
      const dir2 = dirname(path);
      await fs.mkdir(dir2, { recursive: true });
      await fs.appendFile(path, args.content || "", "utf-8");
      return { success: true, output: `Appended ${(args.content || "").length} bytes to ${path}` };
    }
    case "filesystem.delete_file": {
      if (!isAllowedWrite(path)) return { success: false, output: "", error: `Write access denied: ${path}` };
      await fs.unlink(path);
      return { success: true, output: `Deleted ${path}` };
    }
    case "filesystem.move": {
      const src = resolvePath(args.source);
      const dst = resolvePath(args.destination);
      if (!isAllowedRead(src) || !isAllowedWrite(dst)) return { success: false, output: "", error: "Access denied (read source or write destination)" };
      await fs.rename(src, dst);
      return { success: true, output: `Moved ${src} → ${dst}` };
    }
    case "filesystem.copy": {
      const src = resolvePath(args.source);
      const dst = resolvePath(args.destination);
      if (!isAllowedRead(src) || !isAllowedWrite(dst)) return { success: false, output: "", error: "Access denied (read source or write destination)" };
      const recurse = args.recurse !== false;
      await fs.cp(src, dst, { recursive: recurse });
      return { success: true, output: `Copied ${src} → ${dst}` };
    }
    case "filesystem.exists": {
      try {
        await fs.access(path);
        const stat = await fs.stat(path);
        return { success: true, output: `Exists: ${stat.isDirectory() ? "directory" : "file"}` };
      } catch {
        return { success: true, output: "Does not exist" };
      }
    }
    case "filesystem.edit_file": {
      if (!isAllowedWrite(path)) return { success: false, output: "", error: `Write access denied: ${path}` };
      if (!isAllowedRead(path)) return { success: false, output: "", error: `Read access denied: ${path}` };
      const oldStr = args.old_string;
      const newStr = args.new_string;
      if (typeof oldStr !== "string" || typeof newStr !== "string") {
        return { success: false, output: "", error: "old_string and new_string are required" };
      }
      if (oldStr === newStr) {
        return { success: false, output: "", error: "old_string and new_string are identical — no change needed" };
      }
      const fileContent = await fs.readFile(path, "utf-8");
      if (!fileContent.includes(oldStr)) {
        return { success: false, output: "", error: `old_string not found in file. Make sure it matches exactly (including whitespace and indentation).` };
      }
      if (args.replace_all) {
        const count = fileContent.split(oldStr).length - 1;
        const updated = fileContent.split(oldStr).join(newStr);
        await fs.writeFile(path, updated, "utf-8");
        return { success: true, output: `Replaced ${count} occurrence(s) in ${path}` };
      } else {
        const occurrences = fileContent.split(oldStr).length - 1;
        if (occurrences > 1) {
          return { success: false, output: "", error: `old_string matches ${occurrences} locations — must be unique. Add more surrounding context to make it unique, or set replace_all=true.` };
        }
        const idx = fileContent.indexOf(oldStr);
        const updated = fileContent.substring(0, idx) + newStr + fileContent.substring(idx + oldStr.length);
        await fs.writeFile(path, updated, "utf-8");
        return { success: true, output: `Edited ${path} (replaced 1 occurrence)` };
      }
    }
    case "filesystem.read_lines": {
      if (!isAllowedRead(path)) return { success: false, output: "", error: `Read access denied: ${path}` };
      const content = await fs.readFile(path, "utf-8");
      const allLines = content.split(/\r?\n/);
      const startLine = Math.max(1, safeInt(args.start_line, 1));
      const endLine = args.end_line ? Math.min(allLines.length, safeInt(args.end_line, allLines.length)) : allLines.length;
      if (startLine > allLines.length) {
        return { success: false, output: "", error: `start_line ${startLine} exceeds file length (${allLines.length} lines)` };
      }
      const selected = allLines.slice(startLine - 1, endLine);
      const numbered = selected.map((line, i) => `${(startLine + i).toString().padStart(4)}| ${line}`);
      const header = `Lines ${startLine}-${Math.min(endLine, allLines.length)} of ${allLines.length} total`;
      return { success: true, output: `${header}\n${numbered.join("\n")}` };
    }
    case "filesystem.diff": {
      const pathA = args.path_a ? resolvePath(args.path_a) : "";
      if (!pathA) return { success: false, output: "", error: "path_a is required" };
      if (!isAllowedRead(pathA)) return { success: false, output: "", error: `Read access denied: ${pathA}` };
      const contextLines = safeInt(args.context_lines, 3);

      let contentA: string;
      let contentB: string;
      let labelA = pathA;
      let labelB: string;

      try { contentA = await fs.readFile(pathA, "utf-8"); } catch { return { success: false, output: "", error: `Cannot read ${pathA}` }; }

      if (args.content_b != null) {
        contentB = args.content_b;
        labelB = "(provided content)";
      } else if (args.path_b) {
        const pathB = resolvePath(args.path_b);
        if (!isAllowedRead(pathB)) return { success: false, output: "", error: `Read access denied: ${pathB}` };
        try { contentB = await fs.readFile(pathB, "utf-8"); } catch { return { success: false, output: "", error: `Cannot read ${pathB}` }; }
        labelB = pathB;
      } else {
        return { success: false, output: "", error: "Provide either path_b or content_b to compare against" };
      }

      if (contentA === contentB) {
        return { success: true, output: "Files are identical — no differences found." };
      }

      // Simple unified diff implementation
      const linesA = contentA.split(/\r?\n/);
      const linesB = contentB.split(/\r?\n/);
      const hunks: string[] = [];
      hunks.push(`--- ${labelA}`);
      hunks.push(`+++ ${labelB}`);

      // Find changed regions by scanning for mismatched lines
      let i = 0, j = 0;
      while (i < linesA.length || j < linesB.length) {
        // Skip matching lines
        if (i < linesA.length && j < linesB.length && linesA[i] === linesB[j]) {
          i++; j++; continue;
        }
        // Found a difference — build a hunk
        const hunkStartA = Math.max(0, i - contextLines);
        const hunkStartB = Math.max(0, j - contextLines);
        const hunkLines: string[] = [];

        // Context before
        for (let c = hunkStartA; c < i; c++) {
          hunkLines.push(` ${linesA[c]}`);
        }

        // Find the end of this changed region
        let lookAhead = 0;
        let matchCount = 0;
        let ai = i, bj = j;
        while (ai < linesA.length || bj < linesB.length) {
          if (ai < linesA.length && bj < linesB.length && linesA[ai] === linesB[bj]) {
            matchCount++;
            if (matchCount >= contextLines * 2 + 1) { ai -= matchCount - 1; bj -= matchCount - 1; break; }
            ai++; bj++;
          } else {
            matchCount = 0;
            // Advance the shorter side, or both
            if (ai < linesA.length && (bj >= linesB.length || lookAhead % 2 === 0)) { hunkLines.push(`-${linesA[ai]}`); ai++; }
            if (bj < linesB.length && (ai >= linesA.length || lookAhead % 2 === 1)) { hunkLines.push(`+${linesB[bj]}`); bj++; }
            lookAhead++;
          }
          if (hunkLines.length > 200) break; // cap hunk size
        }

        // Context after
        const afterEnd = Math.min(ai + contextLines, Math.max(linesA.length, linesB.length));
        for (let c = ai; c < afterEnd && c < linesA.length; c++) {
          hunkLines.push(` ${linesA[c]}`);
        }

        const removedCount = hunkLines.filter(l => l.startsWith("-")).length;
        const addedCount = hunkLines.filter(l => l.startsWith("+")).length;
        const contextCount = hunkLines.filter(l => l.startsWith(" ")).length;
        hunks.push(`@@ -${hunkStartA + 1},${removedCount + contextCount} +${hunkStartB + 1},${addedCount + contextCount} @@`);
        hunks.push(...hunkLines);

        i = ai; j = bj;
        if (hunkLines.length > 200) break;
      }

      const diffOutput = hunks.join("\n");
      const maxLen = 6000;
      if (diffOutput.length > maxLen) {
        return { success: true, output: diffOutput.substring(0, maxLen) + `\n\n... (truncated, ${diffOutput.length} total chars)` };
      }
      return { success: true, output: diffOutput };
    }
    case "filesystem.file_info": {
      if (!isAllowedRead(path)) return { success: false, output: "", error: `Read access denied: ${path}` };
      const stat = await fs.stat(path);
      return {
        success: true,
        output: JSON.stringify({
          size: stat.size,
          isDirectory: stat.isDirectory(),
          created: stat.birthtime.toISOString(),
          modified: stat.mtime.toISOString(),
          accessed: stat.atime.toISOString(),
        }, null, 2),
      };
    }
    case "filesystem.download": {
      const url = args.url;
      if (!url) return { success: false, output: "", error: "url is required" };
      const destPath = args.path ? resolvePath(args.path) : "";
      if (!destPath) return { success: false, output: "", error: "path is required" };
      if (!isAllowedWrite(destPath)) return { success: false, output: "", error: `Write access denied: ${destPath}` };
      const dlTimeout = args.timeout_seconds ? Math.min(safeInt(args.timeout_seconds, 120), 600) * 1000 : 120_000;

      const { default: https } = await import("https");
      const { default: http } = await import("http");
      const fetcher = url.startsWith("https") ? https : http;

      return new Promise((resolve) => {
        const timer = setTimeout(() => { resolve({ success: false, output: "", error: `Download timed out after ${dlTimeout / 1000}s` }); }, dlTimeout);
        const req = fetcher.get(url, async (res: any) => {
          // Follow redirects
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            clearTimeout(timer);
            req.destroy();
            // Retry with redirect URL
            const redirectFetcher = res.headers.location.startsWith("https") ? https : http;
            const req2 = redirectFetcher.get(res.headers.location, async (res2: any) => {
              if (res2.statusCode !== 200) { clearTimeout(timer); resolve({ success: false, output: "", error: `HTTP ${res2.statusCode}` }); return; }
              const chunks: Buffer[] = [];
              res2.on("data", (c: Buffer) => chunks.push(c));
              res2.on("end", async () => {
                clearTimeout(timer);
                try {
                  const dir = destPath.substring(0, destPath.lastIndexOf("\\") > 0 ? destPath.lastIndexOf("\\") : destPath.lastIndexOf("/"));
                  await fs.mkdir(dir, { recursive: true });
                  await fs.writeFile(destPath, Buffer.concat(chunks));
                  const size = Buffer.concat(chunks).length;
                  resolve({ success: true, output: `Downloaded ${size} bytes to ${destPath}` });
                } catch (e: any) { resolve({ success: false, output: "", error: e.message }); }
              });
            });
            req2.on("error", (e: Error) => { clearTimeout(timer); resolve({ success: false, output: "", error: e.message }); });
            return;
          }
          if (res.statusCode !== 200) { clearTimeout(timer); resolve({ success: false, output: "", error: `HTTP ${res.statusCode}` }); return; }
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", async () => {
            clearTimeout(timer);
            try {
              const dir = destPath.substring(0, destPath.lastIndexOf("\\") > 0 ? destPath.lastIndexOf("\\") : destPath.lastIndexOf("/"));
              await fs.mkdir(dir, { recursive: true });
              await fs.writeFile(destPath, Buffer.concat(chunks));
              const size = Buffer.concat(chunks).length;
              resolve({ success: true, output: `Downloaded ${size} bytes to ${destPath}` });
            } catch (e: any) { resolve({ success: false, output: "", error: e.message }); }
          });
        });
        req.on("error", (e: Error) => { clearTimeout(timer); resolve({ success: false, output: "", error: e.message }); });
      });
    }
    case "filesystem.archive": {
      const src = args.source ? resolvePath(args.source) : "";
      const dest = args.destination ? resolvePath(args.destination) : "";
      if (!src) return { success: false, output: "", error: "source is required" };
      if (!dest) return { success: false, output: "", error: "destination is required" };
      if (!isAllowedRead(src)) return { success: false, output: "", error: `Read access denied: ${src}` };
      if (!isAllowedWrite(dest)) return { success: false, output: "", error: `Write access denied: ${dest}` };

      // Use PowerShell's Compress-Archive
      const safeSrc = src.replace(/'/g, "''");
      const safeDest = dest.replace(/'/g, "''");
      return runPowershell(`Compress-Archive -Path '${safeSrc}' -DestinationPath '${safeDest}' -Force; "Archived to ${safeDest}"`, 120_000);
    }
    case "filesystem.extract": {
      const src = args.source ? resolvePath(args.source) : "";
      const dest = args.destination ? resolvePath(args.destination) : "";
      if (!src) return { success: false, output: "", error: "source is required" };
      if (!dest) return { success: false, output: "", error: "destination is required" };
      if (!isAllowedRead(src)) return { success: false, output: "", error: `Read access denied: ${src}` };
      if (!isAllowedWrite(dest)) return { success: false, output: "", error: `Write access denied: ${dest}` };

      const safeSrc = src.replace(/'/g, "''");
      const safeDest = dest.replace(/'/g, "''");
      return runPowershell(`Expand-Archive -Path '${safeSrc}' -DestinationPath '${safeDest}' -Force; "Extracted to ${safeDest}"`, 120_000);
    }
    default:
      return { success: false, output: "", error: `Unknown filesystem tool: ${toolId}` };
  }
}

// ============================================
// DIRECTORY HANDLERS
// ============================================

async function handleDirectory(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  const path = args.path ? resolvePath(args.path) : "";

  switch (toolId) {
    case "directory.list": {
      if (!isAllowedRead(path)) return { success: false, output: "", error: `Read access denied: ${path}` };
      const entries = await fs.readdir(path, { withFileTypes: true });
      const lines = await Promise.all(entries.map(async (e) => {
        const fullPath = resolve(path, e.name);
        if (e.isDirectory()) {
          return `[DIR]  ${e.name}`;
        } else {
          try {
            const stat = await fs.stat(fullPath);
            return `[FILE] ${e.name} (${stat.size} bytes)`;
          } catch {
            return `[FILE] ${e.name}`;
          }
        }
      }));
      return { success: true, output: lines.join("\n") };
    }
    case "directory.create": {
      if (!isAllowedWrite(path)) return { success: false, output: "", error: `Write access denied: ${path}` };
      await fs.mkdir(path, { recursive: true });
      return { success: true, output: `Created directory: ${path}` };
    }
    case "directory.delete": {
      if (!isAllowedWrite(path)) return { success: false, output: "", error: `Write access denied: ${path}` };
      return runPowershell(`Remove-Item -LiteralPath "${sanitizeForPS(path)}" -Recurse -Force`);
    }
    case "directory.find": {
      if (!isAllowedRead(path)) return { success: false, output: "", error: `Read access denied: ${path}` };
      const depth = safeInt(args.maxDepth, 5);
      const pattern = sanitizeForPS(args.pattern || "*");
      return runPowershell(`Get-ChildItem -LiteralPath "${sanitizeForPS(path)}" -Filter "${pattern}" -Recurse -Depth ${depth} | Select-Object -ExpandProperty FullName`);
    }
    case "directory.tree": {
      if (!isAllowedRead(path)) return { success: false, output: "", error: `Read access denied: ${path}` };
      const depth = safeInt(args.maxDepth, 3);
      const safePath = sanitizeForPS(path);
      return runPowershell(`
function Show-Tree { param($Path, $Indent = "", $Depth = 0, $MaxDepth = ${depth})
  if ($Depth -ge $MaxDepth) { return }
  Get-ChildItem -LiteralPath $Path -ErrorAction SilentlyContinue | Sort-Object { !$_.PSIsContainer }, Name | ForEach-Object {
    $type = if($_.PSIsContainer){"[DIR]"}else{"[FILE]"}
    Write-Output "$Indent$type $($_.Name)"
    if($_.PSIsContainer) { Show-Tree -Path $_.FullName -Indent "$Indent  " -Depth ($Depth+1) -MaxDepth $MaxDepth }
  }
}
Show-Tree -Path "${safePath}"`.trim());
    }
    case "directory.grep": {
      if (!isAllowedRead(path)) return { success: false, output: "", error: `Read access denied: ${path}` };
      const pattern = args.pattern;
      if (!pattern) return { success: false, output: "", error: "pattern is required" };
      const maxResults = safeInt(args.max_results, 50);
      const caseSensitive = args.case_sensitive === true;
      const includeGlob = args.include || "";

      // Build a recursive file search + grep using Node.js for cross-platform support
      const results: string[] = [];
      const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "__pycache__", ".cache", "coverage"]);
      const BINARY_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".zip", ".tar", ".gz", ".exe", ".dll", ".so", ".dylib", ".pdf"]);

      async function grepDir(dir: string, depth: number): Promise<void> {
        if (depth > 8 || results.length >= maxResults) return;
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (results.length >= maxResults) break;
          const fullPath = resolve(dir, entry.name);
          if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) await grepDir(fullPath, depth + 1);
          } else {
            const ext = entry.name.substring(entry.name.lastIndexOf(".")).toLowerCase();
            if (BINARY_EXTS.has(ext)) continue;
            if (includeGlob) {
              const globExt = includeGlob.startsWith("*.") ? includeGlob.substring(1).toLowerCase() : null;
              if (globExt && ext !== globExt) continue;
            }
            try {
              const stat = await fs.stat(fullPath);
              if (stat.size > 1024 * 1024) continue; // skip files > 1MB
              const content = await fs.readFile(fullPath, "utf-8");
              const lines = content.split(/\r?\n/);
              const flags = caseSensitive ? "" : "i";
              let regex: RegExp;
              try { regex = new RegExp(pattern, flags); } catch { regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags); }
              for (let i = 0; i < lines.length && results.length < maxResults; i++) {
                if (regex.test(lines[i])) {
                  const relPath = fullPath.substring(path.length).replace(/\\/g, "/").replace(/^\//, "");
                  results.push(`${relPath}:${i + 1}: ${lines[i].trimEnd()}`);
                }
              }
            } catch { /* skip unreadable files */ }
          }
        }
      }

      await grepDir(path, 0);
      if (results.length === 0) {
        return { success: true, output: `No matches found for "${pattern}" in ${path}` };
      }
      const header = results.length >= maxResults ? `Found ${maxResults}+ matches (capped). Narrow your search with 'include' or a more specific pattern.` : `Found ${results.length} match(es)`;
      return { success: true, output: `${header}\n\n${results.join("\n")}` };
    }
    case "directory.size": {
      if (!isAllowedRead(path)) return { success: false, output: "", error: `Read access denied: ${path}` };
      return runPowershell(`(Get-ChildItem -LiteralPath "${sanitizeForPS(path)}" -Recurse -File | Measure-Object -Property Length -Sum).Sum | ForEach-Object { "$([math]::Round($_ / 1MB, 2)) MB" }`);
    }
    default:
      return { success: false, output: "", error: `Unknown directory tool: ${toolId}` };
  }
}

// ============================================
// SHELL HANDLERS
// ============================================

async function handleShell(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "shell.powershell": {
      if (commandTargetsProtectedProcess(args.command)) {
        return { success: false, output: "", error: "Blocked: this command would kill DotBot's own process. The local agent and server must not be terminated by tool calls." };
      }
      const timeoutMs = args.timeout_seconds ? Math.min(safeInt(args.timeout_seconds, 30), 600) * 1000 : 30_000;
      return runPowershell(args.command, timeoutMs);
    }
    case "shell.node":
      if (!isRuntimeAvailable("node")) {
        return { success: false, output: "", error: `Node.js is not available. ${getRuntimeInstallHint("node")}` };
      }
      return runProcess("node", ["-e", args.script], 30_000);
    case "shell.bash": {
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

async function handleNpmDevServer(args: Record<string, any>): Promise<ToolExecResult> {
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

// ============================================
// CLIPBOARD HANDLERS
// ============================================

async function handleClipboard(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "clipboard.read":
      return runPowershell("Get-Clipboard");
    case "clipboard.write": {
      // Use single-quoted string with only single-quote escaping (PS single-quotes don't expand)
      const safe = (args.content || "").replace(/'/g, "''");
      return runPowershell(`Set-Clipboard -Value '${safe}'`);
    }
    default:
      return { success: false, output: "", error: `Unknown clipboard tool: ${toolId}` };
  }
}

// ============================================
// SYSTEM HANDLERS
// ============================================

async function handleSystem(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "system.process_list": {
      const top = safeInt(args.top, 20);
      const filter = args.filter ? `-Name "*${sanitizeForPS(args.filter)}*"` : "";
      return runPowershell(`Get-Process ${filter} | Sort-Object -Property CPU -Descending | Select-Object -First ${top} Name, Id, CPU, @{N='MemMB';E={[math]::Round($_.WorkingSet64/1MB,1)}} | Format-Table -AutoSize | Out-String`);
    }
    case "system.kill_process": {
      const protectedPids = getProtectedPids();
      if (args.pid) {
        const pid = safeInt(args.pid, -1);
        if (pid < 0) return { success: false, output: "", error: "Invalid PID" };
        if (protectedPids.has(pid)) {
          return { success: false, output: "", error: `Blocked: PID ${pid} is DotBot's own process. The local agent and server must not be terminated by tool calls.` };
        }
        return runPowershell(`Stop-Process -Id ${pid} -Force`);
      }
      if (args.name) {
        const nameLower = (args.name as string).toLowerCase();
        if (nameLower === "node" || nameLower === "node.exe") {
          return { success: false, output: "", error: "Blocked: killing all 'node' processes would terminate DotBot itself. Use a specific PID instead, and verify it is not DotBot's process." };
        }
        return runPowershell(`Stop-Process -Name "${sanitizeForPS(args.name)}" -Force`);
      }
      return { success: false, output: "", error: "Provide either name or pid" };
    }
    case "system.info":
      return runPowershell(`
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
@"
OS: $($os.Caption) $($os.Version)
CPU: $($cpu.Name)
RAM: $([math]::Round($os.TotalVisibleMemorySize/1MB,1)) GB total, $([math]::Round($os.FreePhysicalMemory/1MB,1)) GB free
Disk C: $([math]::Round($disk.Size/1GB,1)) GB total, $([math]::Round($disk.FreeSpace/1GB,1)) GB free
Uptime: $((Get-Date) - $os.LastBootUpTime | ForEach-Object { "$($_.Days)d $($_.Hours)h $($_.Minutes)m" })
"@`.trim());
    case "system.env_get":
      return { success: true, output: process.env[args.name] || `(not set: ${args.name})` };
    case "system.env_set": {
      const varName = args.name;
      const varValue = args.value ?? "";
      if (!varName) return { success: false, output: "", error: "name is required" };
      const level = (args.level || "process").toLowerCase();

      // Always set at process level
      process.env[varName] = varValue;

      if (level === "user") {
        // Persist to user environment (survives restarts)
        const safeName = sanitizeForPS(varName);
        const safeValue = varValue.replace(/'/g, "''");
        const result = await runPowershell(`[System.Environment]::SetEnvironmentVariable('${safeName}', '${safeValue}', 'User'); "Set ${safeName} at User level"`);
        if (!result.success) return result;
        return { success: true, output: `Set ${varName}=${varValue} (user level, persists across sessions)` };
      }
      return { success: true, output: `Set ${varName}=${varValue} (process level, current session only)` };
    }
    case "system.service_list": {
      const filter = args.filter ? `*${sanitizeForPS(args.filter)}*` : "*";
      const statusFilter = (args.status || "all").toLowerCase();
      let psFilter = "";
      if (statusFilter === "running") psFilter = "| Where-Object { $_.Status -eq 'Running' }";
      else if (statusFilter === "stopped") psFilter = "| Where-Object { $_.Status -eq 'Stopped' }";
      return runPowershell(`Get-Service -Name '${filter}' -ErrorAction SilentlyContinue ${psFilter} | Select-Object Name, DisplayName, Status, StartType | Format-Table -AutoSize | Out-String -Width 200`);
    }
    case "system.service_manage": {
      const svcName = args.name;
      const svcAction = (args.action || "").toLowerCase();
      if (!svcName) return { success: false, output: "", error: "name is required" };
      if (!["start", "stop", "restart"].includes(svcAction)) {
        return { success: false, output: "", error: "action must be 'start', 'stop', or 'restart'" };
      }
      const safeSvc = sanitizeForPS(svcName);
      if (svcAction === "restart") {
        return runPowershell(`Restart-Service -Name '${safeSvc}' -Force; Get-Service -Name '${safeSvc}' | Select-Object Name, Status | Format-Table -AutoSize | Out-String`, 60_000);
      }
      const cmdlet = svcAction === "start" ? "Start-Service" : "Stop-Service";
      return runPowershell(`${cmdlet} -Name '${safeSvc}' -Force; Get-Service -Name '${safeSvc}' | Select-Object Name, Status | Format-Table -AutoSize | Out-String`, 60_000);
    }
    case "system.scheduled_task": {
      const taskAction = (args.action || "").toLowerCase();
      const folder = args.folder || "\\DotBot";

      if (taskAction === "list") {
        return runPowershell(`
try { $tasks = Get-ScheduledTask -TaskPath '${sanitizeForPS(folder)}\\' -ErrorAction Stop } catch { $tasks = @() }
if ($tasks.Count -eq 0) { "No tasks found in ${folder}" } else {
  $tasks | ForEach-Object {
    $info = $_ | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
    [PSCustomObject]@{ Name=$_.TaskName; State=$_.State; NextRun=$info.NextRunTime; LastRun=$info.LastRunTime; LastResult=$info.LastTaskResult }
  } | Format-Table -AutoSize | Out-String -Width 200
}`, 30_000);
      }

      if (taskAction === "delete") {
        const taskName = args.name;
        if (!taskName) return { success: false, output: "", error: "name is required for delete" };
        return runPowershell(`Unregister-ScheduledTask -TaskName '${sanitizeForPS(taskName)}' -TaskPath '${sanitizeForPS(folder)}\\' -Confirm:$false; "Deleted task: ${taskName}"`, 30_000);
      }

      if (taskAction === "create") {
        const taskName = args.name;
        const taskCommand = args.command;
        const trigger = args.trigger;
        if (!taskName) return { success: false, output: "", error: "name is required for create" };
        if (!taskCommand) return { success: false, output: "", error: "command is required for create" };
        if (!trigger) return { success: false, output: "", error: "trigger is required for create (e.g., 'daily 03:00', 'onlogon', 'hourly')" };

        // Parse trigger into PowerShell trigger object
        const safeName = sanitizeForPS(taskName);
        const safeCmd = taskCommand.replace(/'/g, "''");
        const safeFolder = sanitizeForPS(folder);
        let triggerPS = "";

        if (trigger === "onlogon") {
          triggerPS = "$trigger = New-ScheduledTaskTrigger -AtLogon";
        } else if (trigger === "onstart") {
          triggerPS = "$trigger = New-ScheduledTaskTrigger -AtStartup";
        } else if (trigger === "hourly") {
          triggerPS = "$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 365)";
        } else if (trigger.startsWith("daily ")) {
          const time = trigger.substring(6).trim();
          triggerPS = `$trigger = New-ScheduledTaskTrigger -Daily -At '${sanitizeForPS(time)}'`;
        } else if (trigger.startsWith("weekly ")) {
          const parts = trigger.substring(7).trim().split(/\s+/);
          const day = parts[0] || "Monday";
          const time = parts[1] || "00:00";
          triggerPS = `$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${sanitizeForPS(day)} -At '${sanitizeForPS(time)}'`;
        } else if (trigger.startsWith("once ")) {
          const dateTime = trigger.substring(5).trim();
          triggerPS = `$trigger = New-ScheduledTaskTrigger -Once -At '${sanitizeForPS(dateTime)}'`;
        } else {
          return { success: false, output: "", error: `Unknown trigger format: '${trigger}'. Use: 'daily HH:MM', 'weekly DAY HH:MM', 'hourly', 'onlogon', 'onstart', or 'once YYYY-MM-DD HH:MM'` };
        }

        return runPowershell(`
${triggerPS}
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -WindowStyle Hidden -Command "${safeCmd}"'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName '${safeName}' -TaskPath '${safeFolder}' -Trigger $trigger -Action $action -Settings $settings -Force | Select-Object TaskName, State | Format-Table | Out-String`, 30_000);
      }

      return { success: false, output: "", error: "action must be 'create', 'list', or 'delete'" };
    }
    case "system.notification": {
      const title = args.title || "DotBot";
      const message = args.message || "";
      if (!message) return { success: false, output: "", error: "message is required" };
      const safeTitle = title.replace(/'/g, "''");
      const safeMsg = message.replace(/'/g, "''");
      return runPowershell(`
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$template = @"
<toast>
  <visual>
    <binding template="ToastGeneric">
      <text>${safeTitle}</text>
      <text>${safeMsg}</text>
    </binding>
  </visual>
</toast>
"@
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($template)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('DotBot').Show($toast)
"Notification sent: ${safeTitle}"`, 15_000);
    }
    case "system.restart": {
      const reason = args.reason || "No reason provided";
      console.log(`[System] Restart requested: ${reason}`);
      // Cancel server-side tasks before exiting so they don't run against a dead agent
      setTimeout(async () => {
        try {
          if (_preRestartHook) {
            console.log("[System] Cancelling server tasks before restart...");
            await _preRestartHook();
          }
        } catch (err) {
          console.error("[System] Pre-restart hook failed (proceeding with restart):", err);
        }
        console.log("[System] Exiting with code 42 (restart signal)...");
        process.exit(42);
      }, 500);
      return { success: true, output: `Restart initiated: ${reason}. The agent will restart momentarily.` };
    }
    default:
      return { success: false, output: "", error: `Unknown system tool: ${toolId}` };
  }
}

// ============================================
// NETWORK HANDLERS
// ============================================

async function handleNetwork(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "network.ping": {
      const count = safeInt(args.count, 4);
      return runPowershell(`Test-Connection -ComputerName "${sanitizeForPS(args.host)}" -Count ${count} | Format-Table -AutoSize | Out-String`);
    }
    case "network.dns_lookup": {
      // Validate DNS type is alphanumeric only
      const type = /^[A-Z]{1,10}$/i.test(args.type || "") ? args.type : "A";
      return runPowershell(`Resolve-DnsName -Name "${sanitizeForPS(args.domain)}" -Type ${type} | Format-Table -AutoSize | Out-String`);
    }
    case "network.port_check": {
      const port = safeInt(args.port, 0);
      if (port < 1 || port > 65535) return { success: false, output: "", error: "Invalid port (1-65535)" };
      return runPowershell(`$r = Test-NetConnection -ComputerName "${sanitizeForPS(args.host)}" -Port ${port} -WarningAction SilentlyContinue; "Host: $($r.ComputerName) Port: ${port} Open: $($r.TcpTestSucceeded)"`);
    }
    default:
      return { success: false, output: "", error: `Unknown network tool: ${toolId}` };
  }
}

// ============================================
// RUNTIME HANDLERS (check/install/update)
// ============================================

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

async function handleRuntime(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
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

// ============================================
// NPM HANDLERS
// ============================================

async function handleNpm(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
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

// ============================================
// GIT HANDLERS
// ============================================

async function handleGit(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
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

// ============================================
// CODEGEN HANDLERS (Claude Code / OpenAI Codex)
// ============================================

async function handleCodegen(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
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

// ============================================
// SHARED HELPERS
// ============================================

export function runPowershell(script: string, timeout = 30_000): Promise<ToolExecResult> {
  return runProcess("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script
  ], timeout);
}

export function runProcess(cmd: string, args: string[], timeout: number): Promise<ToolExecResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], timeout });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      resolve({ success: false, output: stdout, error: "Execution timeout" });
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ success: true, output: stdout.trim() });
      } else {
        resolve({ success: false, output: stdout, error: stderr || `Exit code ${code}` });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ success: false, output: "", error: err.message });
    });
  });
}

// ============================================
// LOCAL LLM HANDLER
// ============================================

async function handleLocalLLM(_toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  const prompt = args.prompt as string;
  if (!prompt) {
    return { success: false, output: "", error: "Missing required 'prompt' parameter" };
  }

  try {
    const { queryLocalLLM } = await import("../llm/local-llm.js");
    const maxTokens = Math.min(Number(args.max_tokens) || 512, 2048);
    const system = args.system ? String(args.system) : undefined;
    const response = await queryLocalLLM(prompt, system, maxTokens);
    return { success: true, output: response };
  } catch (err) {
    return { success: false, output: "", error: `Local LLM error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
