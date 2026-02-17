/**
 * Directory Tool Definitions
 */

import type { DotBotTool } from "../../memory/types.js";

export const directoryTools: DotBotTool[] = [
  {
    id: "directory.list",
    name: "list_directory",
    description: "List files and folders in a directory. Returns names, sizes, and types. Only call once per directory.",
    source: "core",
    category: "directory",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to list" },
        recursive: { type: "boolean", description: "List recursively (default: false)" },
        maxDepth: { type: "number", description: "Max depth for recursive listing (default: 3)" },
      },
      required: ["path"],
    },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
  {
    id: "directory.create",
    name: "create_directory",
    description: "Create a directory (and any missing parent directories).",
    source: "core",
    category: "directory",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to create" },
      },
      required: ["path"],
    },
    annotations: { mutatingHint: true },
  },
  {
    id: "directory.delete",
    name: "delete_directory",
    description: "Delete a directory and all its contents recursively.",
    source: "core",
    category: "directory",
    executor: "local",
    runtime: "powershell",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to delete" },
      },
      required: ["path"],
    },
    annotations: { destructiveHint: true, requiresConfirmation: true, mutatingHint: true },
  },
  {
    id: "directory.find",
    name: "find_files",
    description: "Search for files matching a pattern within a directory tree.",
    source: "core",
    category: "directory",
    executor: "local",
    runtime: "powershell",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Root directory to search" },
        pattern: { type: "string", description: "Filename pattern (e.g., *.txt, report*)" },
        maxDepth: { type: "number", description: "Max search depth (default: 5)" },
      },
      required: ["path", "pattern"],
    },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
  {
    id: "directory.tree",
    name: "directory_tree",
    description: "Display directory structure as an indented tree. Useful for understanding project layout.",
    source: "core",
    category: "directory",
    executor: "local",
    runtime: "powershell",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Root directory" },
        maxDepth: { type: "number", description: "Max depth to display (default: 3)" },
      },
      required: ["path"],
    },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
  {
    id: "directory.grep",
    name: "grep_search",
    description: "Search for a text pattern across all files in a directory tree. Returns matching file paths with line numbers and content. Essential for finding where functions, variables, or strings are defined or used in a codebase.",
    source: "core",
    category: "directory",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Root directory to search" },
        pattern: { type: "string", description: "Text or regex pattern to search for" },
        include: { type: "string", description: "File glob to include (e.g., *.ts, *.md). Default: all files" },
        max_results: { type: "number", description: "Maximum number of matches to return (default: 50)" },
        case_sensitive: { type: "boolean", description: "Case-sensitive search (default: false)" },
      },
      required: ["path", "pattern"],
    },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
  {
    id: "directory.size",
    name: "directory_size",
    description: "Calculate total size of a directory and its contents.",
    source: "core",
    category: "directory",
    executor: "local",
    runtime: "powershell",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path" },
      },
      required: ["path"],
    },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
];
