/**
 * Core Tool Definitions
 * 
 * Built-in tools that ship with the local agent. These are always available
 * and cover fundamental capabilities: filesystem, shell, http, etc.
 * 
 * Each tool follows the DotBotTool interface (extends MCP Tool).
 */

import type { DotBotTool } from "../memory/types.js";
import {
  systemTools,
  networkTools,
  secretsTools,
  searchTools,
  toolsManagementTools,
  skillsManagementTools,
  knowledgeTools,
  personaTools,
  codegenTools,
  npmTools,
  gitTools,
  runtimeTools,
  workflowTools,
  llmTools,
  discordTools,
  reminderTools,
  adminTools,
  emailTools,
  marketTools,
} from "./core-tools-extended.js";
import { guiTools } from "./gui/index.js";

// ============================================
// FILESYSTEM TOOLS
// ============================================

const filesystemTools: DotBotTool[] = [
  {
    id: "filesystem.create_file",
    name: "create_file",
    description: "Create a new file with the specified content. Creates parent directories if needed. Use ~/ for user home paths.",
    source: "core",
    category: "filesystem",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Full file path (e.g., ~/Desktop/hello.txt)" },
        content: { type: "string", description: "Content to write to the file" },
      },
      required: ["path", "content"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "filesystem.read_file",
    name: "read_file",
    description: "Read the contents of a file. Returns the full text content.",
    source: "core",
    category: "filesystem",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Full file path to read" },
      },
      required: ["path"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "filesystem.append_file",
    name: "append_file",
    description: "Append content to the end of an existing file. Creates the file if it doesn't exist.",
    source: "core",
    category: "filesystem",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Full file path to append to" },
        content: { type: "string", description: "Content to append" },
      },
      required: ["path", "content"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "filesystem.delete_file",
    name: "delete_file",
    description: "Delete a file. Does not delete directories — use directory.delete for that.",
    source: "core",
    category: "filesystem",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Full file path to delete" },
      },
      required: ["path"],
    },
    annotations: { destructiveHint: true, requiresConfirmation: true },
  },
  {
    id: "filesystem.move",
    name: "move_file",
    description: "Move or rename a file or directory.",
    source: "core",
    category: "filesystem",
    executor: "local",
    runtime: "powershell",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source path" },
        destination: { type: "string", description: "Destination path" },
      },
      required: ["source", "destination"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "filesystem.copy",
    name: "copy_file",
    description: "Copy a file or directory to a new location.",
    source: "core",
    category: "filesystem",
    executor: "local",
    runtime: "powershell",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source path" },
        destination: { type: "string", description: "Destination path" },
        recurse: { type: "boolean", description: "Copy directories recursively (default: true)" },
      },
      required: ["source", "destination"],
    },
    annotations: {},
  },
  {
    id: "filesystem.exists",
    name: "file_exists",
    description: "Check if a file or directory exists at the given path.",
    source: "core",
    category: "filesystem",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to check" },
      },
      required: ["path"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "filesystem.edit_file",
    name: "edit_file",
    description: "Make a targeted edit to a file by finding and replacing a specific string. Much more efficient than rewriting the entire file. The old_string must match exactly (including whitespace and indentation). Use replace_all to replace every occurrence.",
    source: "core",
    category: "filesystem",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Full file path to edit" },
        old_string: { type: "string", description: "Exact text to find in the file (must be unique unless replace_all is true)" },
        new_string: { type: "string", description: "Text to replace it with" },
        replace_all: { type: "boolean", description: "Replace all occurrences, not just the first (default: false)" },
      },
      required: ["path", "old_string", "new_string"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "filesystem.read_lines",
    name: "read_lines",
    description: "Read specific lines from a file by line number range. Returns lines with line numbers prefixed. Use this instead of read_file for large files — read only the section you need.",
    source: "core",
    category: "filesystem",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Full file path to read" },
        start_line: { type: "number", description: "First line to read (1-indexed)" },
        end_line: { type: "number", description: "Last line to read (inclusive). Omit to read to end of file." },
      },
      required: ["path", "start_line"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "filesystem.diff",
    name: "diff_files",
    description: "Compare two files and show the differences in unified diff format. Use this to verify that edits were applied correctly, compare a file before/after changes, or diff a workspace copy against the live version. Can also compare a file against a string.",
    source: "core",
    category: "filesystem",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        path_a: { type: "string", description: "Path to the first file (the 'before' or 'original')" },
        path_b: { type: "string", description: "Path to the second file (the 'after' or 'modified')" },
        content_b: { type: "string", description: "Alternative to path_b: compare path_a against this string content instead of a second file" },
        context_lines: { type: "number", description: "Number of context lines around each change (default: 3)" },
      },
      required: ["path_a"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "filesystem.file_info",
    name: "file_info",
    description: "Get metadata about a file: size, creation date, modification date, type.",
    source: "core",
    category: "filesystem",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to inspect" },
      },
      required: ["path"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "filesystem.download",
    name: "download_file",
    description: "Download a file from a URL and save it to disk. Handles binary files (images, installers, archives) and text. Shows progress for large downloads. Use this instead of http_request when you need to save a file rather than read its content.",
    source: "core",
    category: "filesystem",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to download from" },
        path: { type: "string", description: "Local file path to save to" },
        timeout_seconds: { type: "number", description: "Max seconds to wait (default: 120, max: 600)" },
      },
      required: ["url", "path"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "filesystem.archive",
    name: "create_archive",
    description: "Create a zip archive from files or directories. Use for backups, packaging deployments, or compressing files for transfer.",
    source: "core",
    category: "filesystem",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Path to file or directory to archive" },
        destination: { type: "string", description: "Path for the output .zip file" },
      },
      required: ["source", "destination"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "filesystem.extract",
    name: "extract_archive",
    description: "Extract a zip archive to a directory. Handles .zip files. Creates the destination directory if needed.",
    source: "core",
    category: "filesystem",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Path to the .zip archive" },
        destination: { type: "string", description: "Directory to extract into" },
      },
      required: ["source", "destination"],
    },
    annotations: { destructiveHint: true },
  },
];

// ============================================
// DIRECTORY TOOLS
// ============================================

const directoryTools: DotBotTool[] = [
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
    annotations: { readOnlyHint: true },
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
    annotations: {},
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
    annotations: { destructiveHint: true, requiresConfirmation: true },
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
    annotations: { readOnlyHint: true },
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
    annotations: { readOnlyHint: true },
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
    annotations: { readOnlyHint: true },
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
    annotations: { readOnlyHint: true },
  },
];

// ============================================
// SHELL TOOLS
// ============================================

const shellTools: DotBotTool[] = [
  {
    id: "shell.powershell",
    name: "run_command",
    description: "Run a PowerShell command on the user's Windows PC. Use for creating directories, moving/copying/renaming files, installing software, and multi-step operations. Prefer a single multi-line script over many separate calls. Default timeout is 30 seconds — use timeout_seconds for long-running commands like npm install, git clone, or builds.",
    source: "core",
    category: "shell",
    executor: "local",
    runtime: "powershell",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "PowerShell command or script to execute" },
        timeout_seconds: { type: "number", description: "Max seconds to wait (default: 30). Use 120-300 for npm install, git clone, builds, or other slow commands." },
      },
      required: ["command"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "shell.node",
    name: "run_node",
    description: "Execute a Node.js script. Useful for data processing, JSON manipulation, and API calls.",
    source: "core",
    category: "shell",
    executor: "local",
    runtime: "node",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "JavaScript code to execute with Node.js" },
      },
      required: ["script"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "shell.bash",
    name: "run_bash",
    description: "Run a bash command using WSL or Git Bash (auto-detected). Useful for Unix-style commands, developer tools, and cross-platform scripts. Falls back to Git Bash if WSL is not available.",
    source: "core",
    category: "shell",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command or script to execute" },
        timeout_seconds: { type: "number", description: "Max seconds to wait (default: 30, max: 600)" },
      },
      required: ["command"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "shell.python",
    name: "run_python",
    description: "Execute a Python script. Useful for data science, automation, and scripting.",
    source: "core",
    category: "shell",
    executor: "local",
    runtime: "python",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "Python code to execute" },
      },
      required: ["script"],
    },
    annotations: { destructiveHint: true },
  },
];

// ============================================
// HTTP TOOLS
// ============================================

const httpTools: DotBotTool[] = [
  {
    id: "http.request",
    name: "http_request",
    description: "Make an HTTP request (GET, POST, PUT, DELETE, PATCH). The curl equivalent — use this for calling any REST API, downloading content, or checking URLs. Supports custom headers, body, and auth.",
    source: "core",
    category: "http",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL to request" },
        method: { type: "string", description: "HTTP method: GET, POST, PUT, DELETE, PATCH (default: GET)", enum: ["GET", "POST", "PUT", "DELETE", "PATCH"] },
        headers: { type: "object", description: "Request headers as key-value pairs", additionalProperties: { type: "string" } },
        body: { type: "string", description: "Request body (for POST/PUT/PATCH). JSON string or raw text." },
        auth: { type: "string", description: "Authorization header value (e.g., 'Bearer token123')" },
        timeout: { type: "number", description: "Request timeout in ms (default: 30000)" },
      },
      required: ["url"],
    },
    annotations: {},
  },
  {
    id: "http.render",
    name: "http_render",
    description: "Fetch a web page using a real browser engine that executes JavaScript. Use this instead of http.request when a page is a JavaScript application (React, Angular, etc.) that returns empty HTML with raw fetch. Launches headless Chromium, navigates to the URL, waits for JS to render, and returns the page title, URL, and full rendered text content. Read-only — no interaction.",
    source: "core",
    category: "http",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to render (https:// added if missing)" },
        wait_ms: { type: "number", description: "Extra milliseconds to wait after page load for JS to finish rendering (default: 2000, max: 15000)" },
        timeout: { type: "number", description: "Navigation timeout in ms (default: 30000)" },
      },
      required: ["url"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "http.download",
    name: "download_file",
    description: "Download a file from a URL and save it to a local path.",
    source: "core",
    category: "http",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to download from" },
        path: { type: "string", description: "Local path to save the file" },
      },
      required: ["url", "path"],
    },
    annotations: { destructiveHint: true },
  },
];

// ============================================
// CLIPBOARD TOOLS
// ============================================

const clipboardTools: DotBotTool[] = [
  {
    id: "clipboard.read",
    name: "clipboard_read",
    description: "Read the current contents of the system clipboard.",
    source: "core",
    category: "clipboard",
    executor: "local",
    runtime: "powershell",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "clipboard.write",
    name: "clipboard_write",
    description: "Write text to the system clipboard.",
    source: "core",
    category: "clipboard",
    executor: "local",
    runtime: "powershell",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Text to copy to clipboard" },
      },
      required: ["content"],
    },
    annotations: {},
  },
];

// ============================================
// BROWSER TOOLS
// ============================================

const browserTools: DotBotTool[] = [
  {
    id: "browser.open_url",
    name: "open_url",
    description: "Open a URL in the user's default web browser.",
    source: "core",
    category: "browser",
    executor: "local",
    runtime: "powershell",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open" },
      },
      required: ["url"],
    },
    annotations: {},
  },
];


// ============================================
// EXPORT ALL CORE TOOLS
// ============================================

export const CORE_TOOLS: DotBotTool[] = [
  ...filesystemTools,
  ...directoryTools,
  ...shellTools,
  ...httpTools,
  ...clipboardTools,
  ...browserTools,
  ...systemTools,
  ...networkTools,
  ...secretsTools,
  ...searchTools,
  ...toolsManagementTools,
  ...skillsManagementTools,
  ...codegenTools,
  ...npmTools,
  ...gitTools,
  ...runtimeTools,
  ...workflowTools,
  ...knowledgeTools,
  ...personaTools,
  ...llmTools,
  ...discordTools,
  ...reminderTools,
  ...adminTools,
  ...emailTools,
  ...marketTools,
  ...guiTools,
];

/**
 * Get core tools by category.
 */
export function getCoreToolsByCategory(category: string): DotBotTool[] {
  return CORE_TOOLS.filter(t => t.category === category);
}

/**
 * Get a specific core tool by ID.
 */
export function getCoreTool(id: string): DotBotTool | undefined {
  return CORE_TOOLS.find(t => t.id === id);
}
