/**
 * Execution Types
 *
 * Command execution, results, and schema reports
 * for local-cloud communication.
 */

export type ExecutionType = 
  | "powershell" 
  | "wsl" 
  | "browser" 
  | "file_read" 
  | "file_write"
  | "schema_extract"
  | "clipboard"
  | "tool_execute";

export interface ExecutionCommand {
  id: string;
  type: ExecutionType;
  payload: {
    script?: string;
    action?: string;
    path?: string;
    content?: string;
    args?: string[];
    /** For tool_execute: the dotted tool ID (e.g. "filesystem.create_file") */
    toolId?: string;
    /** For tool_execute: the tool arguments as key-value pairs */
    toolArgs?: Record<string, any>;
  };
  dryRun: boolean;
  timeout: number;
  sandboxed: boolean;
  requiresApproval: boolean;
}

export interface ExecutionResult {
  commandId: string;
  success: boolean;
  output: string;
  error?: string;
  duration: number;
  sideEffects?: string[];
}

export interface SchemaReport {
  type: "spreadsheet" | "document" | "directory" | "database" | "unknown";
  path: string;
  structure: any;
  preview: string;
}
