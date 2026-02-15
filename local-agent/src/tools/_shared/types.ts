/**
 * Shared types for tool execution.
 */

export interface ToolExecResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface RuntimeInfo {
  name: string;
  available: boolean;
  version?: string;
  path?: string;
  installHint?: string;
}
