/**
 * Shell execution helpers — PowerShell, process spawning, input sanitization.
 */

import { spawn } from "child_process";
import type { ToolExecResult } from "./types.js";

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
// PROCESS EXECUTION
// ============================================

export function runPowershell(script: string, timeout = 30_000): Promise<ToolExecResult> {
  return runProcess("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-Command", script
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
