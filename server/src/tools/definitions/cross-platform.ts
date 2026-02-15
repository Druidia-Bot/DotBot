/**
 * Cross-Platform Desktop Tools
 *
 * Tools that work on Windows, Linux, and macOS (DESKTOP platform).
 * These are filtered out only on web platforms.
 */

import type { CoreToolDefinition } from "../core-registry.js";
import type { Platform } from "../types.js";

const DESKTOP: Platform[] = ["windows", "linux", "macos"];

// ============================================
// CROSS-PLATFORM DESKTOP TOOLS
// ============================================

// Filesystem Operations
export const filesystem: CoreToolDefinition[] = [
  { id: "filesystem.create_file", name: "create_file", description: "Create a new file with the specified content. Creates parent directories if needed.", category: "filesystem", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { path: { type: "string", description: "Full file path" }, content: { type: "string", description: "Content to write" } }, required: ["path", "content"] }, annotations: { destructiveHint: true } },
  { id: "filesystem.read_file", name: "read_file", description: "Read the contents of a file. Returns the full text content.", category: "filesystem", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { path: { type: "string", description: "Full file path to read" } }, required: ["path"] }, annotations: { readOnlyHint: true } },
  { id: "filesystem.append_file", name: "append_file", description: "Append content to the end of an existing file. Creates the file if it doesn't exist.", category: "filesystem", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { path: { type: "string", description: "Full file path" }, content: { type: "string", description: "Content to append" } }, required: ["path", "content"] }, annotations: { destructiveHint: true } },
  { id: "filesystem.delete_file", name: "delete_file", description: "Delete a file. Does not delete directories.", category: "filesystem", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { path: { type: "string", description: "Full file path" } }, required: ["path"] }, annotations: { destructiveHint: true, requiresConfirmation: true } },
  { id: "filesystem.exists", name: "file_exists", description: "Check if a file or directory exists at the given path.", category: "filesystem", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, annotations: { readOnlyHint: true } },
  { id: "filesystem.edit_file", name: "edit_file", description: "Make a targeted edit to a file by finding and replacing a specific string.", category: "filesystem", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["path", "old_string", "new_string"] }, annotations: { destructiveHint: true } },
  { id: "filesystem.read_lines", name: "read_lines", description: "Read specific lines from a file by line number range.", category: "filesystem", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { path: { type: "string" }, start_line: { type: "number" }, end_line: { type: "number" } }, required: ["path", "start_line"] }, annotations: { readOnlyHint: true } },
  { id: "filesystem.diff", name: "diff_files", description: "Compare two files and show differences in unified diff format.", category: "filesystem", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { path_a: { type: "string" }, path_b: { type: "string" }, content_b: { type: "string" }, context_lines: { type: "number" } }, required: ["path_a"] }, annotations: { readOnlyHint: true } },
  { id: "filesystem.file_info", name: "file_info", description: "Get metadata about a file: size, creation date, modification date, type.", category: "filesystem", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, annotations: { readOnlyHint: true } },
  { id: "filesystem.download", name: "download_file", description: "Download a file from a URL and save it to disk.", category: "filesystem", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { url: { type: "string" }, path: { type: "string" }, timeout_seconds: { type: "number" } }, required: ["url", "path"] }, annotations: { destructiveHint: true } },
  { id: "filesystem.archive", name: "create_archive", description: "Create a zip archive from files or directories.", category: "filesystem", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" } }, required: ["source", "destination"] }, annotations: { destructiveHint: true } },
  { id: "filesystem.extract", name: "extract_archive", description: "Extract a zip archive to a directory.", category: "filesystem", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" } }, required: ["source", "destination"] }, annotations: { destructiveHint: true } },
  { id: "filesystem.compress_7z", name: "compress_7z", description: "Create a 7z archive with high compression.", category: "filesystem", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { source: { type: "string", description: "File or directory to compress" }, destination: { type: "string", description: "Output .7z file path" }, compression_level: { type: "number", description: "Compression level (0-9)" } }, required: ["source", "destination"] }, annotations: { destructiveHint: true } },
  { id: "filesystem.extract_tar", name: "extract_tar", description: "Extract tar, tar.gz, or tar.bz2 archive.", category: "filesystem", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { source: { type: "string", description: "Path to tar archive" }, destination: { type: "string", description: "Extraction destination" }, format: { type: "string", description: "Archive format", enum: ["tar", "tar.gz", "tar.bz2"] } }, required: ["source", "destination"] }, annotations: { destructiveHint: true } },
  { id: "filesystem.extract_rar", name: "extract_rar", description: "Extract RAR archive to a directory.", category: "filesystem", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { source: { type: "string", description: "Path to RAR archive" }, destination: { type: "string", description: "Extraction destination" }, password: { type: "string", description: "Archive password if encrypted" } }, required: ["source", "destination"] }, annotations: { destructiveHint: true } },
];

// Directory Operations
export const directory: CoreToolDefinition[] = [
  { id: "directory.list", name: "list_directory", description: "List files and folders in a directory.", category: "directory", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { path: { type: "string" }, recursive: { type: "boolean" }, maxDepth: { type: "number" } }, required: ["path"] }, annotations: { readOnlyHint: true } },
  { id: "directory.create", name: "create_directory", description: "Create a directory (and any missing parent directories).", category: "directory", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { id: "directory.grep", name: "grep_search", description: "Search for a text pattern across all files in a directory tree.", category: "directory", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, include: { type: "string" }, max_results: { type: "number" }, case_sensitive: { type: "boolean" } }, required: ["path", "pattern"] }, annotations: { readOnlyHint: true } },
];

// Data Processing
export const data: CoreToolDefinition[] = [
  { id: "data.read_csv", name: "read_csv", description: "Read CSV file and parse into structured data (array of objects).", category: "data", executor: "client", platforms: DESKTOP, requiredRuntimes: ["node"], inputSchema: { type: "object", properties: { path: { type: "string", description: "Path to CSV file" }, delimiter: { type: "string", description: "Column delimiter (default: comma)" }, has_header: { type: "boolean", description: "First row contains headers" }, encoding: { type: "string", description: "File encoding (default: utf8)" } }, required: ["path"] }, annotations: { readOnlyHint: true } },
  { id: "data.write_csv", name: "write_csv", description: "Write structured data (array of objects) to CSV file.", category: "data", executor: "client", platforms: DESKTOP, requiredRuntimes: ["node"], inputSchema: { type: "object", properties: { path: { type: "string", description: "Path to CSV file" }, data: { type: "array", description: "Array of objects to write" }, delimiter: { type: "string", description: "Column delimiter (default: comma)" }, headers: { type: "array", description: "Custom column headers" }, encoding: { type: "string", description: "File encoding (default: utf8)" } }, required: ["path", "data"] }, annotations: { destructiveHint: true } },
  { id: "data.read_excel", name: "read_excel", description: "Read Excel file (.xlsx, .xls) and parse into structured data.", category: "data", executor: "client", platforms: DESKTOP, requiredRuntimes: ["node"], inputSchema: { type: "object", properties: { path: { type: "string", description: "Path to Excel file" }, sheet: { type: "string", description: "Sheet name or index (default: first sheet)" }, range: { type: "string", description: "Cell range to read (e.g., 'A1:D10')" }, has_header: { type: "boolean", description: "First row contains headers" } }, required: ["path"] }, annotations: { readOnlyHint: true } },
  { id: "data.write_excel", name: "write_excel", description: "Write structured data to Excel file (.xlsx).", category: "data", executor: "client", platforms: DESKTOP, requiredRuntimes: ["node"], inputSchema: { type: "object", properties: { path: { type: "string", description: "Path to Excel file" }, data: { type: "array", description: "Array of objects to write" }, sheet: { type: "string", description: "Sheet name (default: 'Sheet1')" }, headers: { type: "array", description: "Custom column headers" } }, required: ["path", "data"] }, annotations: { destructiveHint: true } },
  { id: "data.transform_json", name: "transform_json", description: "Advanced JSON manipulation: filter, map, merge, deep operations.", category: "data", executor: "client", platforms: DESKTOP, requiredRuntimes: ["node"], inputSchema: { type: "object", properties: { input: { type: "string", description: "JSON string or path to JSON file" }, operation: { type: "string", description: "Operation type", enum: ["filter", "map", "merge", "extract", "flatten", "unflatten"] }, params: { type: "object", description: "Operation-specific parameters (e.g., JSONPath, keys)" } }, required: ["input", "operation"] }, annotations: { readOnlyHint: true } },
  { id: "data.transform_xml", name: "transform_xml", description: "Parse XML to JSON or extract specific elements using XPath.", category: "data", executor: "client", platforms: DESKTOP, requiredRuntimes: ["node"], inputSchema: { type: "object", properties: { input: { type: "string", description: "XML string or path to XML file" }, xpath: { type: "string", description: "XPath expression to extract elements" }, to_json: { type: "boolean", description: "Convert result to JSON" } }, required: ["input"] }, annotations: { readOnlyHint: true } },
];

// PDF Operations
export const pdf: CoreToolDefinition[] = [
  { id: "pdf.read", name: "read_pdf", description: "Extract text content from PDF file.", category: "pdf", executor: "client", platforms: DESKTOP, requiredRuntimes: ["node"], inputSchema: { type: "object", properties: { path: { type: "string", description: "Path to PDF file" }, pages: { type: "string", description: "Page range (e.g., '1-5', 'all')" }, format: { type: "string", description: "Output format", enum: ["text", "json"] } }, required: ["path"] }, annotations: { readOnlyHint: true } },
  { id: "pdf.merge", name: "merge_pdfs", description: "Combine multiple PDF files into a single PDF.", category: "pdf", executor: "client", platforms: DESKTOP, requiredRuntimes: ["node"], inputSchema: { type: "object", properties: { input_paths: { type: "array", description: "Array of PDF file paths to merge", items: { type: "string" } }, output_path: { type: "string", description: "Path for merged PDF" } }, required: ["input_paths", "output_path"] }, annotations: { destructiveHint: true } },
  { id: "pdf.split", name: "split_pdf", description: "Split PDF into multiple files by page range or individual pages.", category: "pdf", executor: "client", platforms: DESKTOP, requiredRuntimes: ["node"], inputSchema: { type: "object", properties: { input_path: { type: "string", description: "Path to PDF file" }, output_dir: { type: "string", description: "Directory for output files" }, mode: { type: "string", description: "Split mode", enum: ["pages", "ranges"] }, ranges: { type: "array", description: "Page ranges (e.g., ['1-3', '4-6'])", items: { type: "string" } } }, required: ["input_path", "output_dir"] }, annotations: { destructiveHint: true } },
  { id: "pdf.to_images", name: "pdf_to_images", description: "Convert PDF pages to image files (PNG, JPG).", category: "pdf", executor: "client", platforms: DESKTOP, requiredRuntimes: ["node"], inputSchema: { type: "object", properties: { input_path: { type: "string", description: "Path to PDF file" }, output_dir: { type: "string", description: "Directory for image files" }, format: { type: "string", description: "Image format", enum: ["png", "jpg"] }, dpi: { type: "number", description: "Resolution (default: 150)" }, pages: { type: "string", description: "Page range (e.g., '1-5', 'all')" } }, required: ["input_path", "output_dir"] }, annotations: { destructiveHint: true } },
];

// Database Operations
export const database: CoreToolDefinition[] = [
  { id: "db.sqlite_query", name: "sqlite_query", description: "Execute SQL SELECT query on SQLite database and return results.", category: "database", executor: "client", platforms: DESKTOP, requiredRuntimes: ["node"], inputSchema: { type: "object", properties: { db_path: { type: "string", description: "Path to SQLite database file" }, query: { type: "string", description: "SQL SELECT query" }, params: { type: "array", description: "Query parameters for prepared statements" } }, required: ["db_path", "query"] }, annotations: { readOnlyHint: true } },
  { id: "db.sqlite_execute", name: "sqlite_execute", description: "Execute SQL statement (INSERT, UPDATE, DELETE, CREATE) on SQLite database.", category: "database", executor: "client", platforms: DESKTOP, requiredRuntimes: ["node"], inputSchema: { type: "object", properties: { db_path: { type: "string", description: "Path to SQLite database file" }, statement: { type: "string", description: "SQL statement to execute" }, params: { type: "array", description: "Statement parameters" } }, required: ["db_path", "statement"] }, annotations: { destructiveHint: true } },
  { id: "db.sqlite_import", name: "sqlite_import", description: "Import CSV or JSON data into SQLite table.", category: "database", executor: "client", platforms: DESKTOP, requiredRuntimes: ["node"], inputSchema: { type: "object", properties: { db_path: { type: "string", description: "Path to SQLite database file" }, table: { type: "string", description: "Table name" }, data_path: { type: "string", description: "Path to CSV or JSON file" }, create_table: { type: "boolean", description: "Create table if it doesn't exist" }, truncate: { type: "boolean", description: "Truncate table before import" } }, required: ["db_path", "table", "data_path"] }, annotations: { destructiveHint: true } },
  { id: "db.sqlite_export", name: "sqlite_export", description: "Export SQLite table or query results to CSV or JSON.", category: "database", executor: "client", platforms: DESKTOP, requiredRuntimes: ["node"], inputSchema: { type: "object", properties: { db_path: { type: "string", description: "Path to SQLite database file" }, query: { type: "string", description: "SQL query or table name" }, output_path: { type: "string", description: "Path for output file" }, format: { type: "string", description: "Output format", enum: ["csv", "json"] } }, required: ["db_path", "query", "output_path"] }, annotations: { destructiveHint: true } },
];

// Vision/OCR
export const vision: CoreToolDefinition[] = [
  { id: "vision.ocr", name: "ocr_extract", description: "Extract text from image using OCR (Optical Character Recognition).", category: "vision", executor: "client", platforms: DESKTOP, requiredRuntimes: ["node"], inputSchema: { type: "object", properties: { image_path: { type: "string", description: "Path to image file" }, language: { type: "string", description: "OCR language (default: 'eng')" }, output_format: { type: "string", description: "Output format", enum: ["text", "json"] } }, required: ["image_path"] }, annotations: { readOnlyHint: true } },
  { id: "vision.analyze_image", name: "analyze_image", description: "Analyze image contents using vision AI (requires Gemini API key).", category: "vision", executor: "client", platforms: DESKTOP, credentialRequired: "GEMINI_API_KEY", inputSchema: { type: "object", properties: { image_path: { type: "string", description: "Path to image file" }, prompt: { type: "string", description: "What to analyze (e.g., 'Describe this image', 'What text is visible?')" } }, required: ["image_path", "prompt"] }, annotations: { readOnlyHint: true, costHint: true } },
  { id: "vision.find_in_image", name: "find_in_image", description: "Locate UI elements or text in screenshot using template matching or OCR.", category: "vision", executor: "client", platforms: DESKTOP, requiredRuntimes: ["node"], inputSchema: { type: "object", properties: { image_path: { type: "string", description: "Path to screenshot" }, target: { type: "string", description: "Text or template to find" }, mode: { type: "string", description: "Search mode", enum: ["text", "template"] }, threshold: { type: "number", description: "Match confidence threshold (0-1)" } }, required: ["image_path", "target"] }, annotations: { readOnlyHint: true } },
];

// Shell
export const shell: CoreToolDefinition[] = [
  { id: "shell.node", name: "run_node", description: "Execute a Node.js script.", category: "shell", executor: "client", platforms: DESKTOP, requiredRuntimes: ["node"], inputSchema: { type: "object", properties: { script: { type: "string" } }, required: ["script"] }, annotations: { destructiveHint: true } },
  { id: "shell.bash", name: "run_bash", description: "Run a bash command using WSL or Git Bash.", category: "shell", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { command: { type: "string" }, timeout_seconds: { type: "number" } }, required: ["command"] }, annotations: { destructiveHint: true } },
  { id: "shell.python", name: "run_python", description: "Execute a Python script.", category: "shell", executor: "client", platforms: DESKTOP, requiredRuntimes: ["python"], inputSchema: { type: "object", properties: { script: { type: "string" } }, required: ["script"] }, annotations: { destructiveHint: true } },
  { id: "shell.npm_dev_server", name: "npm_dev_server", description: "Run npm install, start dev server, wait for ready, open browser.", category: "shell", executor: "client", platforms: DESKTOP, requiredRuntimes: ["node"], inputSchema: { type: "object", properties: { project_directory: { type: "string" }, install: { type: "boolean" }, script: { type: "string" }, port: { type: "number" }, open_browser: { type: "boolean" }, timeout_seconds: { type: "number" } }, required: ["project_directory"] }, annotations: { destructiveHint: true } },
];

// HTTP
export const http: CoreToolDefinition[] = [
  { id: "http.request", name: "http_request", description: "Make an HTTP request (GET, POST, PUT, DELETE, PATCH).", category: "http", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { url: { type: "string" }, method: { type: "string" }, headers: { type: "object" }, body: { type: "string" }, auth: { type: "string" }, timeout: { type: "number" } }, required: ["url"] } },
  { id: "http.render", name: "http_render", description: "Fetch a web page using a real browser engine that executes JavaScript.", category: "http", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { url: { type: "string" }, wait_ms: { type: "number" }, timeout: { type: "number" } }, required: ["url"] }, annotations: { readOnlyHint: true } },
  { id: "http.download", name: "download_file", description: "Download a file from a URL and save it to a local path.", category: "http", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { url: { type: "string" }, path: { type: "string" } }, required: ["url", "path"] }, annotations: { destructiveHint: true } },
];

// System (cross-platform)
export const system: CoreToolDefinition[] = [
  { id: "system.env_get", name: "env_get", description: "Get the value of an environment variable.", category: "system", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, annotations: { readOnlyHint: true } },
  { id: "system.env_set", name: "env_set", description: "Set an environment variable.", category: "system", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { name: { type: "string" }, value: { type: "string" }, level: { type: "string" } }, required: ["name", "value"] }, annotations: { destructiveHint: true } },
  { id: "system.restart", name: "restart_self", description: "Gracefully restart the DotBot local agent.", category: "system", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] }, annotations: { destructiveHint: true, requiresConfirmation: true } },
  { id: "system.health_check", name: "health_check", description: "Run a comprehensive health check of the DotBot installation.", category: "system", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { id: "system.update", name: "update_self", description: "Standard update: Pull the latest code from git, install dependencies, build, and restart. Use this when the user says 'update yourself', 'pull an update', 'get the latest version', or 'update to the latest code'. This is a simple git pull + build + restart (NOT the self-improvement code modification workflow). Takes 1-2 minutes. Only works for git-installed DotBot.", category: "system", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { reason: { type: "string", description: "Why the update is needed (for logging)" } } }, annotations: { destructiveHint: true, requiresConfirmation: true } },
  { id: "system.version", name: "version_info", description: "Get the current DotBot version, platform, Node.js version, install directory, and uptime. Use when the user asks 'what version are you?' or 'what version is this?'.", category: "system", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
];

// Secrets
export const secrets: CoreToolDefinition[] = [
  { id: "secrets.list_keys", name: "list_vault_keys", description: "List the names of all credentials in the encrypted vault.", category: "secrets", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { id: "secrets.delete_key", name: "delete_vault_key", description: "Remove a credential from the encrypted vault.", category: "secrets", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] }, annotations: { destructiveHint: true } },
  { id: "secrets.prompt_user", name: "prompt_user_for_credential", description: "Opens a secure credential entry page for the user to enter a sensitive credential.", category: "secrets", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { key_name: { type: "string" }, prompt: { type: "string" }, allowed_domain: { type: "string" }, title: { type: "string" } }, required: ["key_name", "prompt", "allowed_domain"] }, annotations: { destructiveHint: true } },
];

// Search (cross-platform)
export const search: CoreToolDefinition[] = [
  { id: "search.ddg_instant", name: "ddg_instant", description: "Search DuckDuckGo Instant Answer API for quick factual answers.", category: "search", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, annotations: { readOnlyHint: true } },
  { id: "search.brave", name: "brave_search", description: "Search the web using Brave Search API.", category: "search", executor: "client", platforms: DESKTOP, credentialRequired: "BRAVE_SEARCH_API_KEY", inputSchema: { type: "object", properties: { query: { type: "string" }, count: { type: "number" } }, required: ["query"] }, annotations: { readOnlyHint: true } },
  { id: "search.background", name: "background_search", description: "Start a long-running search in the background.", category: "search", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { type: { type: "string" }, query: { type: "string" } }, required: ["type", "query"] }, annotations: { readOnlyHint: true } },
  { id: "search.check_results", name: "check_search_results", description: "Check the status and results of a background search.", category: "search", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] }, annotations: { readOnlyHint: true } },
];

// Tools
export const tools: CoreToolDefinition[] = [
  { id: "tools.save_tool", name: "save_tool", description: "Save a new reusable tool definition (API or script).", category: "tools", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, description: { type: "string" }, category: { type: "string" }, inputSchema: { type: "object" }, apiSpec: { type: "object" }, script: { type: "string" }, runtime: { type: "string" }, credentialRequired: { type: "string" } }, required: ["id", "name", "description", "category", "inputSchema"] }, annotations: { destructiveHint: true } },
  { id: "tools.list_tools", name: "list_tools", description: "List all currently registered tools.", category: "tools", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { category: { type: "string" }, source: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { id: "tools.delete_tool", name: "delete_tool", description: "Remove a previously saved tool definition.", category: "tools", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, annotations: { destructiveHint: true } },
];

// Skills
export const skills: CoreToolDefinition[] = [
  { id: "skills.save_skill", name: "save_skill", description: "Create or update a skill (SKILL.md standard).", category: "skills", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, content: { type: "string" }, tags: { type: "string" }, disableModelInvocation: { type: "boolean" } }, required: ["name", "description", "content"] }, annotations: { destructiveHint: true } },
  { id: "skills.list_skills", name: "list_skills", description: "List all saved skills.", category: "skills", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { id: "skills.read_skill", name: "read_skill", description: "Read the full SKILL.md content for a specific skill.", category: "skills", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] }, annotations: { readOnlyHint: true } },
  { id: "skills.delete_skill", name: "delete_skill", description: "Remove a skill and its entire directory.", category: "skills", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] }, annotations: { destructiveHint: true } },
];

// Codegen
export const codegen: CoreToolDefinition[] = [
  { id: "codegen.execute", name: "codegen_execute", description: "Delegate a task to an installed AI agent (Claude Code or OpenAI Codex CLI).", category: "codegen", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { prompt: { type: "string" }, working_directory: { type: "string" }, system_prompt: { type: "string" }, prefer: { type: "string" } }, required: ["prompt"] }, annotations: { destructiveHint: true } },
  { id: "codegen.status", name: "codegen_status", description: "Check which AI coding agents are installed.", category: "codegen", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
];

// Runtime
export const runtime: CoreToolDefinition[] = [
  { id: "runtime.check", name: "runtime_check", description: "Check if a specific runtime or tool is installed and get its version.", category: "runtime", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, annotations: { readOnlyHint: true } },
  { id: "runtime.install", name: "runtime_install", description: "Install or update a runtime/tool using the best available method.", category: "runtime", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { name: { type: "string" }, update: { type: "boolean" } }, required: ["name"] }, annotations: { destructiveHint: true } },
];

// NPM
export const npm: CoreToolDefinition[] = [
  { id: "npm.run", name: "npm_run", description: "Run an npm command with automatic long timeouts.", category: "npm", executor: "client", platforms: DESKTOP, requiredRuntimes: ["node"], inputSchema: { type: "object", properties: { command: { type: "string" }, packages: { type: "string" }, args: { type: "string" }, working_directory: { type: "string" }, timeout_seconds: { type: "number" } }, required: ["command"] }, annotations: { destructiveHint: true } },
];

// Git
export const git: CoreToolDefinition[] = [
  { id: "git.run", name: "git_run", description: "Run a git command with automatic long timeouts and safety checks.", category: "git", executor: "client", platforms: DESKTOP, requiredRuntimes: ["git"], inputSchema: { type: "object", properties: { command: { type: "string" }, args: { type: "string" }, working_directory: { type: "string" }, timeout_seconds: { type: "number" } }, required: ["command"] }, annotations: { destructiveHint: true } },
];

// Knowledge
export const knowledge: CoreToolDefinition[] = [
  { id: "knowledge.save", name: "save_knowledge", description: "Save a knowledge document as a structured JSON file.", category: "knowledge", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { title: { type: "string" }, content: { type: "string" }, description: { type: "string" }, tags: { type: "string" }, source_url: { type: "string" }, source_type: { type: "string" }, persona_slug: { type: "string" } }, required: ["title", "content"] }, annotations: { destructiveHint: true } },
  { id: "knowledge.list", name: "list_knowledge", description: "List saved knowledge documents with structural skeletons.", category: "knowledge", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { persona_slug: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { id: "knowledge.read", name: "read_knowledge", description: "Read a knowledge document. Use section parameter for specific keys.", category: "knowledge", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { filename: { type: "string" }, section: { type: "string" }, persona_slug: { type: "string" } }, required: ["filename"] }, annotations: { readOnlyHint: true } },
  { id: "knowledge.search", name: "search_knowledge", description: "Search across knowledge documents for a keyword or phrase.", category: "knowledge", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { query: { type: "string" }, persona_slug: { type: "string" } }, required: ["query"] }, annotations: { readOnlyHint: true } },
  { id: "knowledge.delete", name: "delete_knowledge", description: "Delete a knowledge document by filename.", category: "knowledge", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { filename: { type: "string" }, persona_slug: { type: "string" } }, required: ["filename"] }, annotations: { destructiveHint: true } },
];

// Personas
export const personas: CoreToolDefinition[] = [
  { id: "personas.create", name: "create_persona", description: "Create a new local persona with specific expertise and tools.", category: "personas", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { name: { type: "string" }, role: { type: "string" }, description: { type: "string" }, system_prompt: { type: "string" }, model_tier: { type: "string" }, tools: { type: "string" }, traits: { type: "string" }, expertise: { type: "string" }, triggers: { type: "string" } }, required: ["name", "role", "system_prompt"] }, annotations: { destructiveHint: true } },
  { id: "personas.list", name: "list_personas", description: "List all local personas.", category: "personas", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { id: "personas.read", name: "read_persona", description: "Read a local persona's full definition.", category: "personas", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] }, annotations: { readOnlyHint: true } },
];

// LLM
export const llm: CoreToolDefinition[] = [
  { id: "llm.local_query", name: "local_query", description: "Send a prompt to the local LLM for simple tasks.", category: "llm", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { prompt: { type: "string" }, system: { type: "string" }, max_tokens: { type: "number" } }, required: ["prompt"] }, annotations: { readOnlyHint: true } },
];

// Discord
export const discord: CoreToolDefinition[] = [
  { id: "discord.validate_token", name: "validate_discord_token", description: "Validate a Discord bot token.", category: "discord", executor: "client", platforms: DESKTOP, credentialRequired: "DISCORD_BOT_TOKEN", inputSchema: { type: "object", properties: { token: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { id: "discord.get_invite_url", name: "get_discord_invite_url", description: "Generate the OAuth2 invite URL for adding the bot to a server.", category: "discord", executor: "client", platforms: DESKTOP, credentialRequired: "DISCORD_BOT_TOKEN", inputSchema: { type: "object", properties: { application_id: { type: "string" }, permissions: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { id: "discord.list_guilds", name: "list_discord_guilds", description: "List all Discord servers the bot has been added to.", category: "discord", executor: "client", platforms: DESKTOP, credentialRequired: "DISCORD_BOT_TOKEN", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { id: "discord.list_channels", name: "list_discord_channels", description: "List all channels in a Discord server.", category: "discord", executor: "client", platforms: DESKTOP, credentialRequired: "DISCORD_BOT_TOKEN", inputSchema: { type: "object", properties: { guild_id: { type: "string" } }, required: ["guild_id"] }, annotations: { readOnlyHint: true } },
  { id: "discord.create_channel", name: "create_discord_channel", description: "Create a new text channel in a Discord server.", category: "discord", executor: "client", platforms: DESKTOP, credentialRequired: "DISCORD_BOT_TOKEN", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, name: { type: "string" }, topic: { type: "string" } }, required: ["guild_id", "name"] }, annotations: { destructiveHint: true } },
  { id: "discord.setup_channels", name: "setup_discord_channels", description: "Create the three standard DotBot channels in a Discord server.", category: "discord", executor: "client", platforms: DESKTOP, credentialRequired: "DISCORD_BOT_TOKEN", inputSchema: { type: "object", properties: { guild_id: { type: "string" } }, required: ["guild_id"] }, annotations: { destructiveHint: true } },
  { id: "discord.write_config", name: "write_discord_config", description: "Write Discord configuration to ~/.bot/.env.", category: "discord", executor: "client", platforms: DESKTOP, credentialRequired: "DISCORD_BOT_TOKEN", inputSchema: { type: "object", properties: { guild_id: { type: "string" }, channel_conversation: { type: "string" }, channel_updates: { type: "string" }, channel_logs: { type: "string" }, log_verbosity: { type: "string", enum: ["full", "summary", "off"], description: "Discord #logs channel verbosity: full (all tool calls + stream), summary (lifecycle only), off" } }, required: ["guild_id", "channel_conversation", "channel_updates", "channel_logs"] }, annotations: { destructiveHint: true } },
  { id: "discord.create_guild", name: "create_discord_guild", description: "Create a new Discord server owned by the bot.", category: "discord", executor: "client", platforms: DESKTOP, credentialRequired: "DISCORD_BOT_TOKEN", inputSchema: { type: "object", properties: { name: { type: "string" } } }, annotations: { destructiveHint: true } },
  { id: "discord.create_invite", name: "create_discord_invite", description: "Create an invite link for a Discord channel.", category: "discord", executor: "client", platforms: DESKTOP, credentialRequired: "DISCORD_BOT_TOKEN", inputSchema: { type: "object", properties: { channel_id: { type: "string" }, max_age: { type: "number" }, max_uses: { type: "number" } }, required: ["channel_id"] }, annotations: { destructiveHint: true } },
  { id: "discord.send_message", name: "send_discord_message", description: "Send a message to a Discord channel with optional embeds and buttons.", category: "discord", executor: "client", platforms: DESKTOP, credentialRequired: "DISCORD_BOT_TOKEN", inputSchema: { type: "object", properties: { channel_id: { type: "string" }, content: { type: "string" }, embeds: { type: "array" }, link_buttons: { type: "array" }, action_buttons: { type: "array" } }, required: ["channel_id"] } },
  { id: "discord.send_file", name: "send_discord_file", description: "Upload a file to a Discord channel.", category: "discord", executor: "client", platforms: DESKTOP, credentialRequired: "DISCORD_BOT_TOKEN", inputSchema: { type: "object", properties: { channel_id: { type: "string" }, file_path: { type: "string" }, content: { type: "string" } }, required: ["channel_id", "file_path"] } },
  { id: "discord.full_setup", name: "full_discord_setup", description: "One-shot Discord setup: server, channels, invite, config.", category: "discord", executor: "client", platforms: DESKTOP, credentialRequired: "DISCORD_BOT_TOKEN", inputSchema: { type: "object", properties: { name: { type: "string" } } }, annotations: { destructiveHint: true } },
];

// Reminders
export const reminder: CoreToolDefinition[] = [
  { id: "reminder.set", name: "set_reminder", description: "Set a reminder for a specific date/time.", category: "reminder", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { message: { type: "string" }, scheduled_for: { type: "string" }, priority: { type: "string" } }, required: ["message", "scheduled_for"] }, annotations: { destructiveHint: true } },
  { id: "reminder.list", name: "list_reminders", description: "List all scheduled reminders.", category: "reminder", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { status: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { id: "reminder.cancel", name: "cancel_reminder", description: "Cancel a scheduled reminder.", category: "reminder", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] }, annotations: { destructiveHint: true } },
];

// Admin
export const admin: CoreToolDefinition[] = [
  { id: "admin.create_token", name: "create_invite_token", description: "Generate a new invite token for device registration.", category: "admin", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { label: { type: "string" }, max_uses: { type: "number" }, expiry_days: { type: "number" } } }, annotations: { destructiveHint: true } },
  { id: "admin.list_tokens", name: "list_invite_tokens", description: "List all invite tokens and their status.", category: "admin", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { id: "admin.revoke_token", name: "revoke_invite_token", description: "Revoke an active invite token.", category: "admin", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { token: { type: "string" } }, required: ["token"] }, annotations: { destructiveHint: true } },
  { id: "admin.list_devices", name: "list_registered_devices", description: "List all registered devices.", category: "admin", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { id: "admin.revoke_device", name: "revoke_device", description: "Revoke a registered device.", category: "admin", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { device_id: { type: "string" } }, required: ["device_id"] }, annotations: { destructiveHint: true } },
];

// Market
export const market: CoreToolDefinition[] = [
  { id: "market.polymarket_search", name: "polymarket_search", description: "Search Polymarket prediction markets for events.", category: "market", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] }, annotations: { readOnlyHint: true } },
  { id: "market.polymarket_event", name: "polymarket_event", description: "Get detailed data for a specific Polymarket event.", category: "market", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { slug: { type: "string" }, condition_id: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { id: "market.stock_quote", name: "stock_quote", description: "Get current stock quote data from Finnhub.", category: "market", executor: "client", platforms: DESKTOP, credentialRequired: "FINNHUB_API_KEY", inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] }, annotations: { readOnlyHint: true } },
  { id: "market.stock_profile", name: "stock_profile", description: "Get company profile from Finnhub.", category: "market", executor: "client", platforms: DESKTOP, credentialRequired: "FINNHUB_API_KEY", inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] }, annotations: { readOnlyHint: true } },
  { id: "market.xai_sentiment", name: "xai_sentiment", description: "Ask xAI Grok about real-time sentiment on X/Twitter.", category: "market", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { topic: { type: "string" }, context: { type: "string" } }, required: ["topic"] }, annotations: { readOnlyHint: true } },
  { id: "market.reddit_buzz", name: "reddit_buzz", description: "Search Reddit for recent discussions about a stock or topic.", category: "market", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { query: { type: "string" }, timeframe: { type: "string" }, limit: { type: "number" } }, required: ["query"] }, annotations: { readOnlyHint: true } },
  { id: "market.fear_greed", name: "fear_greed_index", description: "Get the current CNN Fear & Greed Index.", category: "market", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { id: "market.insider_trades", name: "insider_trades", description: "Get recent SEC EDGAR insider trading data for a stock.", category: "market", executor: "client", platforms: DESKTOP, credentialRequired: "FINNHUB_API_KEY", inputSchema: { type: "object", properties: { symbol: { type: "string" }, from_date: { type: "string" }, to_date: { type: "string" } }, required: ["symbol"] }, annotations: { readOnlyHint: true } },
];

// Email
export const email: CoreToolDefinition[] = [
  { id: "email.create_temp", name: "create_temp_email", description: "Create a temporary disposable email address.", category: "email", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { prefix: { type: "string" } } }, annotations: { destructiveHint: true } },
  { id: "email.check_temp_inbox", name: "check_temp_inbox", description: "Check the inbox of the currently active temp email.", category: "email", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { page: { type: "number" } } }, annotations: { readOnlyHint: true } },
  { id: "email.read_temp_message", name: "read_temp_message", description: "Read the full content of a specific temp email message.", category: "email", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { message_id: { type: "string" } }, required: ["message_id"] }, annotations: { readOnlyHint: true } },
  { id: "email.delete_temp", name: "delete_temp_email", description: "Delete the currently active temp email account.", category: "email", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: {} }, annotations: { destructiveHint: true } },
  { id: "email.list_addresses", name: "list_email_addresses", description: "List all active email addresses.", category: "email", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
];

// Onboarding
export const onboarding: CoreToolDefinition[] = [
  { id: "onboarding.status", name: "onboarding_status", description: "Check the current onboarding progress.", category: "onboarding", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { id: "onboarding.complete_step", name: "complete_onboarding_step", description: "Mark an onboarding step as completed.", category: "onboarding", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { step: { type: "string" } }, required: ["step"] }, annotations: { destructiveHint: true } },
  { id: "onboarding.skip_step", name: "skip_onboarding_step", description: "Mark an onboarding step as skipped.", category: "onboarding", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { step: { type: "string" } }, required: ["step"] }, annotations: { destructiveHint: true } },
  { id: "onboarding.mark_not_applicable", name: "mark_onboarding_not_applicable", description: "Mark an onboarding step as not applicable.", category: "onboarding", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { step: { type: "string" } }, required: ["step"] }, annotations: { destructiveHint: true } },
];

// GUI
export const gui: CoreToolDefinition[] = [
  { id: "gui.read_state", name: "gui.read_state", description: "Read current state of the GUI including screenshots and element tree.", category: "gui", executor: "client", platforms: DESKTOP, requiredRuntimes: ["playwright"], inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { id: "gui.navigate", name: "gui.navigate", description: "Navigate to a URL in the browser.", category: "gui", executor: "client", platforms: DESKTOP, requiredRuntimes: ["playwright"], inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { id: "gui.click", name: "gui.click", description: "Click an element on the page.", category: "gui", executor: "client", platforms: DESKTOP, requiredRuntimes: ["playwright"], inputSchema: { type: "object", properties: { selector: { type: "string" }, x: { type: "number" }, y: { type: "number" } } } },
  { id: "gui.type", name: "gui.type", description: "Type text into an element or the active element.", category: "gui", executor: "client", platforms: DESKTOP, requiredRuntimes: ["playwright"], inputSchema: { type: "object", properties: { text: { type: "string" }, selector: { type: "string" } }, required: ["text"] } },
  { id: "gui.screenshot", name: "gui.screenshot", description: "Take a screenshot of the current page or screen.", category: "gui", executor: "client", platforms: DESKTOP, requiredRuntimes: ["playwright"], inputSchema: { type: "object", properties: { fullPage: { type: "boolean" } } }, annotations: { readOnlyHint: true } },
  { id: "gui.scroll", name: "gui.scroll", description: "Scroll the page.", category: "gui", executor: "client", platforms: DESKTOP, requiredRuntimes: ["playwright"], inputSchema: { type: "object", properties: { direction: { type: "string" }, amount: { type: "number" } } } },
  { id: "gui.select", name: "gui.select", description: "Select an option from a dropdown.", category: "gui", executor: "client", platforms: DESKTOP, requiredRuntimes: ["playwright"], inputSchema: { type: "object", properties: { selector: { type: "string" }, value: { type: "string" } }, required: ["selector", "value"] } },
  { id: "gui.wait", name: "gui.wait", description: "Wait for a selector to appear.", category: "gui", executor: "client", platforms: DESKTOP, requiredRuntimes: ["playwright"], inputSchema: { type: "object", properties: { selector: { type: "string" }, timeout: { type: "number" } }, required: ["selector"] } },
  { id: "gui.evaluate", name: "gui.evaluate", description: "Run JavaScript in the browser context.", category: "gui", executor: "client", platforms: DESKTOP, requiredRuntimes: ["playwright"], inputSchema: { type: "object", properties: { script: { type: "string" } }, required: ["script"] } },
  { id: "gui.close", name: "gui.close", description: "Close the browser session.", category: "gui", executor: "client", platforms: DESKTOP, requiredRuntimes: ["playwright"], inputSchema: { type: "object", properties: {} } },
];

// Config — general ~/.bot/.env CRUD
export const config: CoreToolDefinition[] = [
  { id: "config.get", name: "get_config", description: "Read a configuration value from ~/.bot/.env by key. Returns the value or null if not set.", category: "config", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { key: { type: "string", description: "Environment variable name (e.g. DISCORD_LOG_VERBOSITY)" } }, required: ["key"] }, annotations: { readOnlyHint: true } },
  { id: "config.set", name: "set_config", description: "Set a configuration value in ~/.bot/.env. Creates the file if it does not exist. Also updates the running process environment immediately.", category: "config", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { key: { type: "string", description: "Environment variable name" }, value: { type: "string", description: "Value to set. Pass empty string to clear." } }, required: ["key", "value"] }, annotations: { destructiveHint: true } },
  { id: "config.list", name: "list_config", description: "List all configuration keys and values from ~/.bot/.env.", category: "config", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { id: "config.delete", name: "delete_config", description: "Remove a configuration key from ~/.bot/.env and unset it from the running process.", category: "config", executor: "client", platforms: DESKTOP, inputSchema: { type: "object", properties: { key: { type: "string", description: "Environment variable name to remove" } }, required: ["key"] }, annotations: { destructiveHint: true } },
];

/** All cross-platform desktop tools */
export const CROSS_PLATFORM_TOOLS: CoreToolDefinition[] = [
  ...filesystem,
  ...directory,
  ...data,
  ...pdf,
  ...database,
  ...vision,
  ...shell,
  ...http,
  ...system,
  ...secrets,
  ...search,
  ...tools,
  ...skills,
  ...codegen,
  ...runtime,
  ...npm,
  ...git,
  ...knowledge,
  ...personas,
  ...llm,
  ...discord,
  ...reminder,
  ...admin,
  ...market,
  ...email,
  ...onboarding,
  ...gui,
  ...config,
];
