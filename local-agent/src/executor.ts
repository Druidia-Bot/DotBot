/**
 * Command Executor
 * 
 * Executes commands on the local Windows PC:
 * - PowerShell scripts
 * - File read/write operations
 * - Browser automation (future)
 */

import { spawn, execSync } from "child_process";
import { promises as fs } from "fs";
import { resolve, extname } from "path";
import type { ExecutionCommand, ExecutionResult } from "./types.js";

// ============================================
// KNOWN FOLDER RESOLUTION
// ============================================

// Cache of actual Windows known folder paths (Dropbox/OneDrive may redirect these)
const knownFolders: Record<string, string> = {};

function initKnownFolders(): void {
  const folders = ["Desktop", "MyDocuments", "UserProfile"] as const;
  const folderMap: Record<string, string> = {
    Desktop: "Desktop",
    MyDocuments: "Documents",
    UserProfile: "",
  };

  try {
    // Single PowerShell call to resolve all known folders
    const script = folders
      .map(f => `[Environment]::GetFolderPath('${f}')`)
      .join(";");
    const result = execSync(
      `powershell -NoProfile -NonInteractive -Command "${script}"`,
      { encoding: "utf-8", timeout: 5000 }
    ).trim();

    const paths = result.split(/\r?\n/);
    for (let i = 0; i < folders.length; i++) {
      const alias = folderMap[folders[i]];
      if (paths[i] && paths[i].length > 0) {
        if (alias) {
          knownFolders[alias.toLowerCase()] = paths[i];
        }
        knownFolders[folders[i].toLowerCase()] = paths[i];
      }
    }

    // Also resolve Downloads (not a .NET SpecialFolder — derive from profile)
    const profile = knownFolders["userprofile"] || process.env.USERPROFILE || "";
    if (profile) {
      knownFolders["downloads"] = resolve(profile, "Downloads");
    }

    console.log("[Executor] Known folders resolved:", knownFolders);
  } catch (error) {
    console.warn("[Executor] Failed to resolve known folders, using defaults:", error);
    const profile = process.env.USERPROFILE || "";
    knownFolders["desktop"] = resolve(profile, "Desktop");
    knownFolders["documents"] = resolve(profile, "Documents");
    knownFolders["downloads"] = resolve(profile, "Downloads");
  }
}

// Resolve at module load
initKnownFolders();

/**
 * Resolve ~/path to actual Windows paths, using known folder cache.
 * Handles: ~/Desktop, ~/Documents, ~/Downloads, and plain ~/
 */
function resolveUserPath(inputPath: string): string {
  let p = inputPath.replace(/\//g, "\\"); // normalize slashes

  if (p.startsWith("~\\") || p.startsWith("~/") || p === "~") {
    const rest = p.substring(2); // remove ~/
    const firstSegment = rest.split("\\")[0]?.toLowerCase() || "";

    // Check if first segment is a known folder
    if (firstSegment && knownFolders[firstSegment]) {
      const afterFolder = rest.substring(firstSegment.length); // e.g. \hello.txt or empty
      return knownFolders[firstSegment] + afterFolder;
    }

    // Plain ~/ — expand to USERPROFILE
    const profile = knownFolders["userprofile"] || process.env.USERPROFILE || "";
    return profile + "\\" + rest;
  }

  return p;
}

// ============================================
// MAIN EXECUTOR
// ============================================

export async function executeCommand(command: ExecutionCommand): Promise<ExecutionResult> {
  const startTime = Date.now();

  console.log(`[Executor] Received command: ${command.type} (id: ${command.id})`);
  console.log(`[Executor] Payload:`, JSON.stringify(command.payload, null, 2));

  try {
    let output: string;
    let sideEffects: string[] = [];

    switch (command.type) {
      case "powershell":
        output = await executePowerShell(command.payload.script!, command.timeout, command.dryRun);
        if (!command.dryRun && command.payload.script!.includes("Set-") || 
            command.payload.script!.includes("Remove-") ||
            command.payload.script!.includes("New-") ||
            command.payload.script!.includes("Move-")) {
          sideEffects.push("System state modified");
        }
        break;

      case "file_read":
        output = await readFile(resolveUserPath(command.payload.path!));
        break;

      case "file_write":
        output = await writeFile(
          resolveUserPath(command.payload.path!), 
          command.payload.content!, 
          command.dryRun
        );
        if (!command.dryRun) {
          sideEffects.push(`File written: ${command.payload.path}`);
        }
        break;

      case "schema_extract":
        // Handled separately by schema.ts
        output = "Schema extraction delegated";
        break;

      case "tool_execute": {
        // Dynamic tool execution via plugin system
        const { executeTool } = await import("./tools/tool-executor.js");
        const toolResult = await executeTool(
          command.payload.toolId!,
          command.payload.toolArgs || {}
        );
        if (!toolResult.success) {
          // Return error as output instead of throwing — preserves partial output
          // and lets the tool loop feed it back to the LLM as context
          const parts: string[] = [];
          if (toolResult.error) parts.push(`ERROR: ${toolResult.error}`);
          if (toolResult.output) parts.push(`Partial output:\n${toolResult.output}`);
          output = parts.join("\n\n") || "Tool execution failed";
          sideEffects.push(`Tool ${command.payload.toolId} failed`);
          break;
        }
        output = toolResult.output;
        if (toolResult.output) sideEffects.push(`Tool ${command.payload.toolId} executed`);
        break;
      }

      default:
        throw new Error(`Unsupported command type: ${command.type}`);
    }

    return {
      commandId: command.id,
      success: true,
      output,
      duration: Date.now() - startTime,
      sideEffects: sideEffects.length > 0 ? sideEffects : undefined
    };

  } catch (error) {
    return {
      commandId: command.id,
      success: false,
      output: "",
      error: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - startTime
    };
  }
}

// ============================================
// POWERSHELL EXECUTION
// ============================================

async function executePowerShell(
  script: string, 
  timeout: number,
  dryRun: boolean
): Promise<string> {
  // In dry run mode, wrap script with -WhatIf where applicable
  const finalScript = dryRun 
    ? wrapWithWhatIf(script)
    : script;

  return new Promise((resolve, reject) => {
    const args = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "RemoteSigned",
      "-Command", finalScript
    ];

    const ps = spawn("powershell.exe", args, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout
    });

    let stdout = "";
    let stderr = "";

    ps.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    ps.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ps.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr || `PowerShell exited with code ${code}`));
      }
    });

    ps.on("error", (error) => {
      reject(error);
    });

    // Handle timeout
    setTimeout(() => {
      ps.kill();
      reject(new Error("Execution timeout"));
    }, timeout);
  });
}

/**
 * Wrap PowerShell commands with -WhatIf for dry run
 */
function wrapWithWhatIf(script: string): string {
  // Commands that support -WhatIf
  const whatIfCommands = [
    "Remove-Item", "Move-Item", "Copy-Item", "Rename-Item",
    "New-Item", "Set-Content", "Add-Content", "Clear-Content",
    "Set-ItemProperty", "Remove-ItemProperty",
    "Start-Process", "Stop-Process"
  ];

  let wrapped = script;
  for (const cmd of whatIfCommands) {
    // Add -WhatIf to commands that don't already have it
    const regex = new RegExp(`(${cmd}\\s+)(?!.*-WhatIf)`, "gi");
    wrapped = wrapped.replace(regex, `$1-WhatIf `);
  }

  return wrapped;
}

// ============================================
// FILE OPERATIONS
// ============================================

async function readFile(path: string): Promise<string> {
  const resolvedPath = resolve(path);
  
  // Security check: only allow certain paths
  if (!isAllowedPath(resolvedPath)) {
    throw new Error(`Access denied: ${resolvedPath}`);
  }

  const stat = await fs.stat(resolvedPath);
  
  // Limit file size
  const MAX_SIZE = 10 * 1024 * 1024; // 10MB
  if (stat.size > MAX_SIZE) {
    throw new Error(`File too large: ${stat.size} bytes (max ${MAX_SIZE})`);
  }

  const content = await fs.readFile(resolvedPath, "utf-8");
  return content;
}

async function writeFile(
  path: string, 
  content: string, 
  dryRun: boolean
): Promise<string> {
  const resolvedPath = resolve(path);
  console.log(`[Executor] writeFile: input="${path}" resolved="${resolvedPath}" dryRun=${dryRun}`);
  
  if (!isAllowedPath(resolvedPath)) {
    console.log(`[Executor] writeFile: ACCESS DENIED for ${resolvedPath}`);
    throw new Error(`Access denied: ${resolvedPath}`);
  }

  if (dryRun) {
    return `[DRY RUN] Would write ${content.length} bytes to ${resolvedPath}`;
  }

  // Ensure parent directory exists
  const parentDir = resolvedPath.substring(0, resolvedPath.lastIndexOf('\\') || resolvedPath.lastIndexOf('/'));
  try {
    await fs.access(parentDir);
  } catch {
    console.log(`[Executor] writeFile: Creating parent dir ${parentDir}`);
    await fs.mkdir(parentDir, { recursive: true });
  }

  await fs.writeFile(resolvedPath, content, "utf-8");
  console.log(`[Executor] writeFile: SUCCESS - ${content.length} bytes to ${resolvedPath}`);
  return `Written ${content.length} bytes to ${resolvedPath}`;
}

// ============================================
// SECURITY
// ============================================

const ALLOWED_PATHS = [
  // User directories
  process.env.USERPROFILE,
  process.env.HOME,
  // Common safe locations
  "C:\\Users",
  "D:\\",
  // Temp
  process.env.TEMP,
  process.env.TMP
].filter(Boolean);

const BLOCKED_PATHS = [
  "C:\\Windows",
  "C:\\Program Files",
  "C:\\Program Files (x86)",
  "C:\\ProgramData",
  process.env.SystemRoot
].filter(Boolean);

function isAllowedPath(path: string): boolean {
  const normalizedPath = path.toLowerCase().replace(/\//g, "\\");
  
  // Check blocked paths first
  for (const blocked of BLOCKED_PATHS) {
    if (normalizedPath.startsWith(blocked!.toLowerCase())) {
      return false;
    }
  }
  
  // Then check allowed paths
  for (const allowed of ALLOWED_PATHS) {
    if (normalizedPath.startsWith(allowed!.toLowerCase())) {
      return true;
    }
  }
  
  // Default: allow if in user profile
  const userProfile = process.env.USERPROFILE?.toLowerCase();
  if (userProfile && normalizedPath.startsWith(userProfile)) {
    return true;
  }
  
  return false;
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

export function getFileExtension(path: string): string {
  return extname(path).toLowerCase();
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function listDirectory(path: string): Promise<string[]> {
  const resolvedPath = resolve(path);
  
  if (!isAllowedPath(resolvedPath)) {
    throw new Error(`Access denied: ${resolvedPath}`);
  }
  
  return await fs.readdir(resolvedPath);
}
