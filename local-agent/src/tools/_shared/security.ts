/**
 * Security utilities — path validation, dangerous command detection, sensitive file blocking.
 */

import { resolve, dirname } from "path";
import { knownFolders } from "./path.js";

const SYSTEM_PATHS = ["c:\\windows", "c:\\program files", "c:\\program files (x86)", "c:\\programdata", "c:\\$recycle.bin"];

// ============================================
// SELF-PROCESS PROTECTION
// ============================================

/** PIDs that must never be killed — DotBot's own process tree. */
export function getProtectedPids(): Set<number> {
  const pids = new Set<number>();
  pids.add(process.pid);
  if (process.ppid) pids.add(process.ppid);
  return pids;
}

/** Check if a shell command attempts to kill a protected PID. */
export function commandTargetsProtectedProcess(command: string): boolean {
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
// DANGEROUS COMMAND PATTERNS
// ============================================

/**
 * SEC-04: Dangerous command patterns that LLM-generated PowerShell must never run.
 * Each entry: [regex, human-readable reason].
 * Matched case-insensitively against the full command string.
 */
export const DANGEROUS_PS_PATTERNS: Array<[RegExp, string]> = [
  [/\bFormat-(?:Volume|Disk)\b/i, "disk formatting"],
  [/\bClear-Disk\b/i, "disk wiping"],
  [/\bInitialize-Disk\b/i, "disk initialization"],
  [/\bbcdedit\b/i, "boot configuration editing"],
  [/\bRemove-Item\s[^|]*?-Recurse[^|]*?(?:C:\\Windows|C:\\Program\sFiles|\$env:SystemRoot|\$env:windir)/i, "recursive deletion of system directories"],
  [/\bRemove-Item\s[^|]*?(?:C:\\Windows|C:\\Program\sFiles|\$env:SystemRoot|\$env:windir)[^|]*?-Recurse/i, "recursive deletion of system directories"],
  [/\breg\s+(?:delete|import)\s+(?:HKLM|HKEY_LOCAL_MACHINE)\\SYSTEM/i, "system registry hive manipulation"],
  [/\bRemove-ItemProperty\s[^|]*?HKLM:\\SYSTEM/i, "system registry hive manipulation"],
  [/\bDisable-NetAdapter\b/i, "network adapter disabling"],
  [/\bStop-Computer\b/i, "computer shutdown"],
  [/\bRestart-Computer\b/i, "computer restart"],
  [/\bsfc\s+\/scannow\b/i, "system file checker (requires elevation)"],
  [/\bdism\b[^|]*?\/Online\b[^|]*?\/Cleanup-Image/i, "DISM system image manipulation"],
  [/\bSet-ExecutionPolicy\s+Unrestricted/i, "disabling script execution policy"],
];

/**
 * SEC-04B: Dangerous Bash/Unix patterns that LLM-generated bash must never run.
 * Each entry: [regex, human-readable reason].
 * Matched against the full command string.
 */
export const DANGEROUS_BASH_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\s+-rf\s+\/(?!\S)/, "recursive deletion of root directory"],
  [/\brm\s+-rf\s+\/(?:bin|boot|dev|etc|lib|lib64|proc|root|sbin|sys|usr)\b/, "recursive deletion of system directories"],
  [/\bmkfs\b/, "filesystem formatting"],
  [/\bdd\s+if=/, "direct disk write (can overwrite filesystems)"],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, "fork bomb"],
  [/\bshutdown\b/, "system shutdown"],
  [/\breboot\b/, "system reboot"],
  [/\bpoweroff\b/, "system poweroff"],
  [/\binit\s+[06]\b/, "system halt/reboot via init"],
  [/\bsudo\s+rm\s+-rf\s+\//, "sudo recursive deletion of root"],
  [/\bchmod\s+-R\s+000/, "recursive permission removal"],
  [/>\s*\/dev\/sd[a-z]\b/, "direct write to disk device"],
  [/\bmv\s+\/(?:bin|sbin|usr\/bin|usr\/sbin)\b/, "moving system binaries"],
];

/** Check if a PowerShell command matches any dangerous pattern. Returns reason or null. */
export function matchesDangerousPattern(command: string): string | null {
  for (const [pattern, reason] of DANGEROUS_PS_PATTERNS) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

/** Check if a Bash command matches any dangerous pattern. Returns reason or null. */
export function matchesDangerousBashPattern(command: string): string | null {
  for (const [pattern, reason] of DANGEROUS_BASH_PATTERNS) {
    if (pattern.test(command)) return reason;
  }
  return null;
}
