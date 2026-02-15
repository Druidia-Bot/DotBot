/**
 * Shared utilities for tool handlers.
 */

export type { ToolExecResult, RuntimeInfo } from "./types.js";
export { knownFolders, resolvePath } from "./path.js";
export {
  isAllowedRead,
  isAllowedWrite,
  getProtectedPids,
  commandTargetsProtectedProcess,
  matchesDangerousPattern,
  matchesDangerousBashPattern,
  DANGEROUS_PS_PATTERNS,
  DANGEROUS_BASH_PATTERNS,
} from "./security.js";
export {
  sanitizeForPS,
  safeInt,
  isAllowedUrl,
  runPowershell,
  runProcess,
} from "./powershell.js";
