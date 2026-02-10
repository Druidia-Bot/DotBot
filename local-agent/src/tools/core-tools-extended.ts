/**
 * Core Tool Definitions — Extended Categories
 *
 * System, network, secrets, search, tools management, and skills management.
 * Split from core-tools.ts for maintainability.
 */

import type { DotBotTool } from "../memory/types.js";

// ============================================
// SYSTEM TOOLS
// ============================================

export const systemTools: DotBotTool[] = [
  {
    id: "system.process_list",
    name: "process_list",
    description: "List running processes with CPU and memory usage.",
    source: "core",
    category: "system",
    executor: "local",
    runtime: "powershell",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Optional process name filter" },
        top: { type: "number", description: "Number of top processes to show (default: 20)" },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "system.kill_process",
    name: "kill_process",
    description: "Kill a process by name or PID.",
    source: "core",
    category: "system",
    executor: "local",
    runtime: "powershell",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Process name (e.g., 'notepad')" },
        pid: { type: "number", description: "Process ID" },
      },
    },
    annotations: { destructiveHint: true, requiresConfirmation: true },
  },
  {
    id: "system.info",
    name: "system_info",
    description: "Get system information: OS, CPU, RAM, disk space, uptime.",
    source: "core",
    category: "system",
    executor: "local",
    runtime: "powershell",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "system.env_get",
    name: "env_get",
    description: "Get the value of an environment variable.",
    source: "core",
    category: "system",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Environment variable name" },
      },
      required: ["name"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "system.env_set",
    name: "env_set",
    description: "Set an environment variable. Can set at process level (current session only) or user level (persists across sessions). Use for non-sensitive config (channel IDs, feature flags, PATH additions) and free API keys you discovered yourself. NEVER use this for user-provided API keys or tokens — those MUST go through secrets.prompt_user for server-side encryption.",
    source: "core",
    category: "system",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Environment variable name" },
        value: { type: "string", description: "Value to set (empty string to clear)" },
        level: { type: "string", description: "'process' (current session only, default) or 'user' (persists across sessions)" },
      },
      required: ["name", "value"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "system.service_list",
    name: "service_list",
    description: "List Windows services with their status. Filter by name or show only running/stopped services.",
    source: "core",
    category: "system",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Optional name filter (partial match)" },
        status: { type: "string", description: "Filter by status: 'running', 'stopped', or 'all' (default: 'all')" },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "system.service_manage",
    name: "service_manage",
    description: "Start, stop, or restart a Windows service. Requires the service name (not display name). Use service_list to find service names first.",
    source: "core",
    category: "system",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Service name (e.g., 'docker', 'wslservice', 'W3SVC')" },
        action: { type: "string", description: "'start', 'stop', or 'restart'" },
      },
      required: ["name", "action"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "system.scheduled_task",
    name: "scheduled_task",
    description: "Create, list, or delete Windows Task Scheduler entries. Use for automating recurring tasks like updates, backups, health checks, or starting services at login.",
    source: "core",
    category: "system",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "'create', 'list', or 'delete'" },
        name: { type: "string", description: "Task name (required for create/delete)" },
        command: { type: "string", description: "Command to run (required for create)" },
        trigger: { type: "string", description: "When to run: 'daily HH:MM', 'weekly DAY HH:MM', 'hourly', 'onlogon', 'onstart', or 'once YYYY-MM-DD HH:MM' (required for create)" },
        folder: { type: "string", description: "Task Scheduler folder (default: '\\DotBot')" },
      },
      required: ["action"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "system.notification",
    name: "notify",
    description: "Show a Windows toast notification. Use to alert the user when a long-running task completes, an error occurs, or attention is needed.",
    source: "core",
    category: "system",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Notification title" },
        message: { type: "string", description: "Notification body text" },
      },
      required: ["title", "message"],
    },
    annotations: {},
  },
  {
    id: "system.restart",
    name: "restart_self",
    description: "Gracefully restart the DotBot local agent. The agent process exits with a restart signal and the launcher automatically restarts it. Use when you need to pick up configuration changes, recover from a bad state, or after a self-update. Only works when running under the launcher (production mode) — in dev mode (tsx watch) the process will simply exit.",
    source: "core",
    category: "system",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why the restart is needed (logged for debugging)" },
      },
      required: ["reason"],
    },
    annotations: { destructiveHint: true, requiresConfirmation: true },
  },
];

// ============================================
// NETWORK TOOLS
// ============================================

export const networkTools: DotBotTool[] = [
  {
    id: "network.ping",
    name: "ping",
    description: "Ping a host to check connectivity and latency.",
    source: "core",
    category: "network",
    executor: "local",
    runtime: "powershell",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Hostname or IP to ping" },
        count: { type: "number", description: "Number of pings (default: 4)" },
      },
      required: ["host"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "network.dns_lookup",
    name: "dns_lookup",
    description: "Look up DNS records for a domain.",
    source: "core",
    category: "network",
    executor: "local",
    runtime: "powershell",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Domain to look up" },
        type: { type: "string", description: "Record type: A, AAAA, MX, TXT, CNAME (default: A)" },
      },
      required: ["domain"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "network.port_check",
    name: "port_check",
    description: "Check if a TCP port is open on a host.",
    source: "core",
    category: "network",
    executor: "local",
    runtime: "powershell",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Hostname or IP" },
        port: { type: "number", description: "Port number to check" },
      },
      required: ["host", "port"],
    },
    annotations: { readOnlyHint: true },
  },
];

// ============================================
// SECRETS TOOLS
// ============================================

export const secretsTools: DotBotTool[] = [
  {
    id: "secrets.list_keys",
    name: "list_vault_keys",
    description: "List the names of all credentials in the encrypted vault (values are NEVER shown). Credentials are server-encrypted and can only be used via the server proxy.",
    source: "core",
    category: "secrets",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "secrets.delete_key",
    name: "delete_vault_key",
    description: "Remove a credential from the encrypted vault.",
    source: "core",
    category: "secrets",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Environment variable name to remove" },
      },
      required: ["key"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "secrets.prompt_user",
    name: "prompt_user_for_credential",
    description: "Opens a secure credential entry page on the server for the user to enter a sensitive credential (API key, token, etc.). The credential is encrypted server-side with domain scoping — it can ONLY be used for API calls to the specified allowed_domain. A QR code is provided so the user can enter the credential from their phone (recommended for maximum security). The LLM NEVER sees the credential value. This is the preferred way to collect credentials.",
    source: "core",
    category: "secrets",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        key_name: { type: "string", description: "Vault key name to store the credential under (e.g., 'DISCORD_BOT_TOKEN', 'OPENAI_API_KEY')" },
        prompt: { type: "string", description: "Message shown to the user on the entry page explaining what to enter and where to find it" },
        allowed_domain: { type: "string", description: "The API domain this credential will be used with (e.g., 'discord.com', 'api.openai.com'). The credential is cryptographically bound to this domain and cannot be used elsewhere." },
        title: { type: "string", description: "Entry page title (default: 'DotBot — Secure Credential Entry')" },
      },
      required: ["key_name", "prompt", "allowed_domain"],
    },
    annotations: { destructiveHint: true },
  },
];

// ============================================
// SEARCH TOOLS
// ============================================

export const searchTools: DotBotTool[] = [
  {
    id: "search.ddg_instant",
    name: "ddg_instant",
    description: "Search DuckDuckGo Instant Answer API for quick factual answers, definitions, summaries, and related topics. Free, no API key required. Best for: definitions, quick facts, Wikipedia summaries, calculations. For deep web research, use search.brave instead.",
    source: "core",
    category: "search",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "search.brave",
    name: "brave_search",
    description: "Search the web using Brave Search API. Returns full web search results with titles, URLs, and descriptions. Requires a free API key (2,000 queries/month free tier). If the key is not configured, this tool will return setup instructions.",
    source: "core",
    category: "search",
    executor: "local",
    runtime: "internal",
    credentialRequired: "BRAVE_SEARCH_API_KEY",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        count: { type: "number", description: "Number of results to return (default 5, max 20)" },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "search.background",
    name: "background_search",
    description: "Start a long-running search in the background. Returns a task ID immediately — use search.check_results to poll for results. Available search types: 'file_content' (grep user directories), 'deep_memory' (scan cold storage models), 'archived_threads' (search archived conversation threads by topic/entities).",
    source: "core",
    category: "search",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["file_content", "deep_memory", "archived_threads"], description: "Type of background search to run" },
        query: { type: "string", description: "Search query or keywords" },
      },
      required: ["type", "query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "search.check_results",
    name: "check_search_results",
    description: "Check the status and results of a background search started with search.background. Returns 'running' if still in progress, or the full results if complete.",
    source: "core",
    category: "search",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task ID returned by search.background" },
      },
      required: ["task_id"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "search.files",
    name: "search_files",
    description: "Search for files on the entire computer using Everything (instant NTFS-indexed search). Searches filenames and paths — not file content. Supports wildcards (*.pdf), extensions (ext:py), paths (path:projects), and boolean operators. Requires Everything to be running. Returns up to 50 results with file paths and sizes.",
    source: "core",
    category: "search",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Everything search query. Examples: 'budget 2024 ext:xlsx', '*.py path:projects', 'readme.md'" },
        max_results: { type: "number", description: "Maximum results to return (default 50, max 200)" },
        match_path: { type: "boolean", description: "If true, matches against full path instead of just filename (default false)" },
        sort: { type: "string", description: "Sort order: 'name', 'path', 'size', 'date-modified' (default 'date-modified')" },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
];

// ============================================
// TOOLS MANAGEMENT (Self-Learning)
// ============================================

export const toolsManagementTools: DotBotTool[] = [
  {
    id: "tools.save_tool",
    name: "save_tool",
    description: "Save a new reusable tool definition. Supports two types: (1) API tools — provide apiSpec for HTTP-based tools that call external APIs. (2) Script tools — provide script (source code) and runtime ('python', 'node', or 'powershell') for local tools that run as scripts. Scripts receive args as JSON on stdin and should output JSON on stdout. The tool will be registered and available in all future conversations.",
    source: "core",
    category: "tools",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Dotted tool ID (e.g., 'weather.current', 'utils.pdf_to_text')" },
        name: { type: "string", description: "Short tool name for use in tool calls" },
        description: { type: "string", description: "What this tool does — be specific about inputs and outputs" },
        category: { type: "string", description: "Category for grouping (e.g., 'weather', 'utils', 'data')" },
        inputSchema: { type: "object", description: "JSON Schema for the tool's input parameters" },
        apiSpec: {
          type: "object",
          description: "For API tools: { baseUrl, method, path, headers?, queryParams?, authType, keySource?, keyEnvVar? }",
        },
        script: { type: "string", description: "For script tools: the full source code of the script. Receives JSON args on stdin, outputs JSON on stdout." },
        runtime: { type: "string", enum: ["python", "node", "powershell"], description: "For script tools: execution runtime" },
        credentialRequired: { type: "string", description: "Vault credential name if this tool needs an API key (optional)" },
      },
      required: ["id", "name", "description", "category", "inputSchema"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "tools.list_tools",
    name: "list_tools",
    description: "List all currently registered tools, optionally filtered by category or source.",
    source: "core",
    category: "tools",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Filter by category (optional)" },
        source: { type: "string", description: "Filter by source: core, api, mcp, skill, custom (optional)" },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "tools.delete_tool",
    name: "delete_tool",
    description: "Remove a previously saved API or custom tool definition.",
    source: "core",
    category: "tools",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Tool ID to remove (e.g., 'weather.current')" },
      },
      required: ["id"],
    },
    annotations: { destructiveHint: true },
  },
];

// ============================================
// RUNTIME TOOLS (check/install/update runtimes)
// ============================================

export const runtimeTools: DotBotTool[] = [
  {
    id: "runtime.check",
    name: "runtime_check",
    description: "Check if a specific runtime or tool is installed and get its version. Re-probes on demand (not cached). Use this before trying to use a tool you're unsure about, or to verify an installation succeeded. Pass 'all' to check everything.",
    source: "core",
    category: "runtime",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Runtime to check: node, npm, python, git, docker, powershell, claude, codex, wsl, gitbash — or 'all' for everything" },
      },
      required: ["name"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "runtime.install",
    name: "runtime_install",
    description: "Install or update a runtime/tool using the best available method for this OS. On Windows uses winget for system tools (node, python, git) and npm for CLI tools (claude, codex). Automatically chooses install vs update based on whether it's already present.",
    source: "core",
    category: "runtime",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "What to install/update: node, npm, python, git, claude, codex" },
        update: { type: "boolean", description: "Force update even if already installed (default: false — installs only if missing)" },
      },
      required: ["name"],
    },
    annotations: { destructiveHint: true },
  },
];

// ============================================
// NPM TOOLS
// ============================================

export const npmTools: DotBotTool[] = [
  {
    id: "npm.run",
    name: "npm_run",
    description: "Run an npm command with automatic long timeouts. Handles install, update, uninstall, run (scripts), init, audit, and any other npm subcommand. Use this instead of shell.powershell for npm operations — it has sensible defaults and won't time out on large installs.",
    source: "core",
    category: "npm",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "npm subcommand: install, update, uninstall, run, init, audit, list, outdated, etc." },
        packages: { type: "string", description: "Space-separated package names (for install/update/uninstall). E.g., '@openai/codex typescript vitest'" },
        args: { type: "string", description: "Extra flags: -g (global), --save-dev, -w (workspace), etc." },
        working_directory: { type: "string", description: "Directory to run in (default: current directory)" },
        timeout_seconds: { type: "number", description: "Max seconds (default: 120, max: 600)" },
      },
      required: ["command"],
    },
    annotations: { destructiveHint: true },
  },
];

// ============================================
// GIT TOOLS
// ============================================

export const gitTools: DotBotTool[] = [
  {
    id: "git.run",
    name: "git_run",
    description: "Run a git command with automatic long timeouts and safety checks. Handles clone, pull, push, fetch, checkout, branch, status, log, add, commit, merge, diff, remote, stash, and more. Blocks dangerous operations like force-push and deleting main/master. Use this instead of shell.powershell for git operations.",
    source: "core",
    category: "git",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "git subcommand: clone, pull, push, fetch, checkout, branch, status, log, add, commit, merge, diff, remote, stash, etc." },
        args: { type: "string", description: "Arguments for the git subcommand (e.g., branch name, remote URL, file paths, flags)" },
        working_directory: { type: "string", description: "Directory to run in (default: current directory)" },
        timeout_seconds: { type: "number", description: "Max seconds (default: 120, max: 600)" },
      },
      required: ["command"],
    },
    annotations: { destructiveHint: true },
  },
];

// ============================================
// CODEGEN TOOLS (Claude Code / OpenAI Codex CLI)
// ============================================

export const codegenTools: DotBotTool[] = [
  {
    id: "codegen.execute",
    name: "codegen_execute",
    description: "Delegate a task to an installed AI agent (Claude Code or OpenAI Codex CLI). These agents can read, analyze, create, and modify files with full project context — not just coding. Use for: multi-file code changes, building sites/apps, code review, writing documentation, analyzing data files, researching a codebase, refactoring, or any task that benefits from deep filesystem awareness. Requires 'claude' or 'codex' CLI to be installed. Runs non-interactively in the specified working directory.",
    source: "core",
    category: "codegen",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to do — describe the coding task clearly" },
        working_directory: { type: "string", description: "Directory to run in (default: ~/.bot/workspace/dotbot)" },
        system_prompt: { type: "string", description: "Optional system prompt to prepend (e.g., project context, constraints)" },
        prefer: { type: "string", description: "Preferred CLI: 'claude' or 'codex'. If not set, uses whichever is available (claude preferred)." },
      },
      required: ["prompt"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "codegen.status",
    name: "codegen_status",
    description: "Check which AI coding agents (Claude Code, OpenAI Codex CLI) are installed and available on this system.",
    source: "core",
    category: "codegen",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: { readOnlyHint: true },
  },
];

// ============================================
// WORKFLOW TOOLS
// ============================================

export const workflowTools: DotBotTool[] = [
  {
    id: "shell.npm_dev_server",
    name: "npm_dev_server",
    description: "All-in-one workflow: run `npm install` (or update), start `npm run dev` (or a custom script), wait for the dev server to be ready on a port, then open it in Chrome. Handles the full setup-to-preview cycle in one call.",
    source: "core",
    category: "shell",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        project_directory: { type: "string", description: "Absolute path to the project root (where package.json lives)" },
        install: { type: "boolean", description: "Run npm install first (default: true)" },
        script: { type: "string", description: "npm script to run (default: 'dev'). Can also be 'start', 'serve', etc." },
        port: { type: "number", description: "Port to wait for (default: auto-detect from package.json or 3000)" },
        open_browser: { type: "boolean", description: "Open the URL in Chrome when ready (default: true)" },
        timeout_seconds: { type: "number", description: "Max seconds to wait for server to start (default: 60)" },
      },
      required: ["project_directory"],
    },
    annotations: { destructiveHint: true },
  },
];

// ============================================
// SKILLS MANAGEMENT (SKILL.md Standard)
// ============================================

export const skillsManagementTools: DotBotTool[] = [
  {
    id: "skills.save_skill",
    name: "save_skill",
    description: "Create or update a skill following the SKILL.md standard. A skill is a directory at ~/.bot/skills/{slug}/ with a SKILL.md file containing YAML frontmatter (name, description, tags) and markdown instructions. Use this to save reusable workflows, design systems, coding conventions, or any behavioral instructions the system should follow when triggered.",
    source: "core",
    category: "skills",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name — becomes the /slash-command (e.g., 'frontend-design')" },
        description: { type: "string", description: "What this skill does and when to use it. Helps the system decide when to auto-load." },
        content: { type: "string", description: "Markdown instructions the LLM follows when this skill is invoked. This is the body of SKILL.md (after the frontmatter)." },
        tags: { type: "string", description: "Comma-separated tags for search/discovery (e.g., 'frontend,design,react,ui')" },
        disableModelInvocation: { type: "boolean", description: "If true, only the user can invoke via /command (not auto-triggered). Default: false." },
      },
      required: ["name", "description", "content"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "skills.list_skills",
    name: "list_skills",
    description: "List all saved skills (SKILL.md directories), optionally filtered by search query.",
    source: "core",
    category: "skills",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query to filter skills (optional)" },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "skills.read_skill",
    name: "read_skill",
    description: "Read the full SKILL.md content for a specific skill, including frontmatter and instructions.",
    source: "core",
    category: "skills",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "The skill slug (directory name)" },
      },
      required: ["slug"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "skills.delete_skill",
    name: "delete_skill",
    description: "Remove a skill and its entire directory.",
    source: "core",
    category: "skills",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "The skill slug to remove" },
      },
      required: ["slug"],
    },
    annotations: { destructiveHint: true },
  },
];

// ============================================
// KNOWLEDGE MANAGEMENT
// ============================================

export const knowledgeTools: DotBotTool[] = [
  {
    id: "knowledge.ingest",
    name: "ingest_knowledge",
    description: `Process a URL, local file, or compressed archive into structured JSON knowledge using Gemini. Supports web pages, PDFs, images, video, audio, API responses, markdown, text, CSV, JSON files, and compressed archives (.zip, .tar.gz, .tgz, .tar, .gz).

For URLs: content is fetched and processed server-side.
For local files: uploaded from the user's machine to the server for processing (no files stored — processed in memory and discarded immediately).
For compressed archives: each file inside is extracted and processed individually, returning knowledge for every file. Supported: .zip, .tar.gz, .tgz, .tar, .gz
For PDFs and binary files: uploaded to Gemini Files API (temporary, deleted immediately after processing).
For text/HTML: sent inline to Gemini (no file upload).

Security: all uploads are validated — executables are blocked (magic bytes + extension), archive entries are sanitized against path traversal, compression ratio checks detect zip bombs. Max 50 files per archive, 100MB per file, 500MB total extracted.

This tool returns the structured JSON — you should review it, add a title and tags, then save it with knowledge.save.
For archives, each extracted file returns separate knowledge — save each one individually.

Example workflows:
1. knowledge.ingest(source: "https://react.dev/reference/rsc/server-components")
2. knowledge.ingest(source: "C:\\Users\\me\\Documents\\api-spec.pdf")
3. knowledge.ingest(source: "C:\\Users\\me\\Downloads\\docs.tar.gz")
4. Review the returned JSON structure
5. knowledge.save(title: "React Server Components Reference", content: <the JSON>, tags: "react,rsc")`,
    source: "core",
    category: "knowledge",
    executor: "server-proxy",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "URL or local file path to process. URLs: web pages, API endpoints. Local files: PDFs, images, video, audio, markdown, text, CSV, JSON, HTML. Archives: .zip, .tar.gz, .tgz, .tar, .gz" },
      },
      required: ["source"],
    },
  },
  {
    id: "knowledge.save",
    name: "save_knowledge",
    description: `Save a knowledge document as a structured JSON file. Use this after you've fetched and processed content from a URL, PDF, API response, image description, or any other source.

The content parameter is a JSON string where each key is an "aspect" of the knowledge and each value is the detail. Structure it like a mental model — keys are concepts, values are everything you know about them. Be exhaustive in the values.

Example content: {"overview": "React Server Components run on...", "directives": ["use server", "use client", "cache()"], "gotchas": ["No useState in server components", ...], "compatibility": "React 19+, Next.js 14+"}

The system automatically builds a compact skeleton from the JSON keys for efficient retrieval — the LLM sees just the structure and can request specific sections on demand via knowledge.read with the section parameter.

If persona_slug is provided, saves to that persona's knowledge directory. Otherwise saves to general knowledge (~/.bot/knowledge/).`,
    source: "core",
    category: "knowledge",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Document title — descriptive and specific (e.g., 'React 19 Server Components API Reference')" },
        content: { type: "string", description: "JSON string with structured knowledge. Keys are aspects/topics, values are detailed content. Example: {\"overview\": \"...\", \"api\": [...], \"gotchas\": [...]}" },
        description: { type: "string", description: "One-line description of what this document covers" },
        tags: { type: "string", description: "Comma-separated tags for discovery (e.g., 'react,server-components,api,reference')" },
        source_url: { type: "string", description: "URL the content was sourced from (if applicable)" },
        source_type: { type: "string", description: "Type of source: 'url', 'pdf', 'image', 'api', 'manual', 'conversation'" },
        persona_slug: { type: "string", description: "Optional: save to a specific persona's knowledge directory instead of general knowledge. The persona must already exist as a local persona." },
      },
      required: ["title", "content"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "knowledge.list",
    name: "list_knowledge",
    description: "List saved knowledge documents with their structural skeletons. Shows the keys and truncated values of each document so you can decide what to read in detail. Short values appear inline; long values show previews with word/item counts.",
    source: "core",
    category: "knowledge",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        persona_slug: { type: "string", description: "Optional: list knowledge for a specific persona instead of general knowledge" },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "knowledge.read",
    name: "read_knowledge",
    description: "Read a knowledge document. Use the 'section' parameter to retrieve a specific key from the JSON (supports dot-notation for nested keys like 'api.endpoints'). Without 'section', returns the full document.",
    source: "core",
    category: "knowledge",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Filename of the knowledge document (e.g., 'react-server-components.json')" },
        section: { type: "string", description: "Optional: specific key to read (e.g., 'gotchas' or 'api.endpoints'). Returns only that section's content instead of the full document." },
        persona_slug: { type: "string", description: "Optional: read from a specific persona's knowledge directory" },
      },
      required: ["filename"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "knowledge.search",
    name: "search_knowledge",
    description: "Search across knowledge documents for a keyword or phrase. Searches both key names and values. Returns matching sections with their paths so you can retrieve them with knowledge.read.",
    source: "core",
    category: "knowledge",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword or phrase to search for across all knowledge documents" },
        persona_slug: { type: "string", description: "Optional: search within a specific persona's knowledge only" },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "knowledge.delete",
    name: "delete_knowledge",
    description: "Delete a knowledge document by filename.",
    source: "core",
    category: "knowledge",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Filename of the knowledge document to delete" },
        persona_slug: { type: "string", description: "Optional: delete from a specific persona's knowledge directory" },
      },
      required: ["filename"],
    },
    annotations: { destructiveHint: true },
  },
];

// ============================================
// PERSONA MANAGEMENT
// ============================================

export const personaTools: DotBotTool[] = [
  {
    id: "personas.create",
    name: "create_persona",
    description: `Create a new local persona. A persona defines a specialized AI personality with specific expertise, tools, and behavior. Saved to ~/.bot/personas/{slug}/ with a persona.json and knowledge/ directory.

The persona will be available for the receptionist to route tasks to. Give it a clear role description and specific expertise areas so the receptionist knows when to use it.`,
    source: "core",
    category: "personas",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name (e.g., 'Marketing Strategist', 'Data Analyst')" },
        role: { type: "string", description: "One-line role description (e.g., 'Expert in digital marketing strategy and campaign optimization')" },
        description: { type: "string", description: "Detailed description of capabilities, approach, and when to use this persona" },
        system_prompt: { type: "string", description: "The full system prompt that defines this persona's behavior, tone, and expertise. Be specific and detailed." },
        model_tier: { type: "string", description: "'fast' (quick tasks), 'smart' (analysis), or 'powerful' (complex reasoning). Default: 'smart'", enum: ["fast", "smart", "powerful"] },
        tools: { type: "string", description: "Comma-separated tool categories this persona can use (e.g., 'filesystem,directory,shell,http'). Use 'all' for everything, 'none' for no tools." },
        traits: { type: "string", description: "Comma-separated personality traits (e.g., 'analytical,precise,thorough')" },
        expertise: { type: "string", description: "Comma-separated areas of expertise (e.g., 'SEO,content marketing,analytics,A/B testing')" },
        triggers: { type: "string", description: "Comma-separated trigger phrases that should route to this persona (e.g., 'marketing,campaign,SEO,ads,social media')" },
      },
      required: ["name", "role", "system_prompt"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "personas.list",
    name: "list_personas",
    description: "List all local personas with their name, role, model tier, and knowledge file count.",
    source: "core",
    category: "personas",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "personas.read",
    name: "read_persona",
    description: "Read a local persona's full definition including system prompt, tools, traits, expertise, and knowledge files.",
    source: "core",
    category: "personas",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Persona slug (directory name)" },
      },
      required: ["slug"],
    },
    annotations: { readOnlyHint: true },
  },
];

// ============================================
// LOCAL LLM TOOLS (runs on user's machine via node-llama-cpp)
// ============================================

// ============================================
// DISCORD SETUP & MANAGEMENT
// ============================================

export const discordTools: DotBotTool[] = [
  {
    id: "discord.validate_token",
    name: "validate_discord_token",
    description: "Validate a Discord bot token by calling the Discord API. Returns the bot's username, ID, and application ID if valid. The token can come from: (1) the encrypted vault (stored by secrets.prompt_user — preferred), (2) an explicit token argument, or (3) process.env. On success, the token is auto-stored in the vault for future use.",
    source: "core",
    category: "discord",
    executor: "local",
    runtime: "internal",
    credentialRequired: "DISCORD_BOT_TOKEN",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Optional. The Discord bot token — only needed if not already stored via secrets.prompt_user." },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "discord.get_invite_url",
    name: "get_discord_invite_url",
    description: "Generate the OAuth2 invite URL for adding the bot to a Discord server. Uses the bot's application ID (auto-detected from stored token if not provided). The user opens this URL in their browser to add the bot to their server.",
    source: "core",
    category: "discord",
    executor: "local",
    runtime: "internal",
    credentialRequired: "DISCORD_BOT_TOKEN",
    inputSchema: {
      type: "object",
      properties: {
        application_id: { type: "string", description: "Discord application/client ID. If omitted, auto-detected from the stored bot token." },
        permissions: { type: "string", description: "Permission integer (default: '8' = Administrator). Use '8' for full access." },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "discord.list_guilds",
    name: "list_discord_guilds",
    description: "List all Discord servers (guilds) the bot has been added to. Uses the stored bot token. Run this after the user invites the bot to verify it's in the right server.",
    source: "core",
    category: "discord",
    executor: "local",
    runtime: "internal",
    credentialRequired: "DISCORD_BOT_TOKEN",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "discord.list_channels",
    name: "list_discord_channels",
    description: "List all channels in a Discord server. Returns channel names, IDs, and types (text/voice/category).",
    source: "core",
    category: "discord",
    executor: "local",
    runtime: "internal",
    credentialRequired: "DISCORD_BOT_TOKEN",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "The Discord server (guild) ID" },
      },
      required: ["guild_id"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "discord.create_channel",
    name: "create_discord_channel",
    description: "Create a new text channel in a Discord server. Requires the bot to have Manage Channels permission.",
    source: "core",
    category: "discord",
    executor: "local",
    runtime: "internal",
    credentialRequired: "DISCORD_BOT_TOKEN",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "The Discord server (guild) ID" },
        name: { type: "string", description: "Channel name (lowercase, no spaces — Discord normalizes automatically)" },
        topic: { type: "string", description: "Optional channel topic/description" },
      },
      required: ["guild_id", "name"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "discord.setup_channels",
    name: "setup_discord_channels",
    description: "All-in-one: creates the three standard DotBot channels (#conversation, #updates, #logs) in a Discord server. Skips any that already exist. Returns the channel IDs ready for discord.write_config.",
    source: "core",
    category: "discord",
    executor: "local",
    runtime: "internal",
    credentialRequired: "DISCORD_BOT_TOKEN",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "The Discord server (guild) ID" },
      },
      required: ["guild_id"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "discord.write_config",
    name: "write_discord_config",
    description: "Write Discord configuration (guild ID, channel IDs) to ~/.bot/.env. The bot token is read from the encrypted vault (stored there by discord.validate_token). Only non-sensitive config is written to .env.",
    source: "core",
    category: "discord",
    executor: "local",
    runtime: "internal",
    credentialRequired: "DISCORD_BOT_TOKEN",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "The Discord server (guild) ID" },
        channel_conversation: { type: "string", description: "Channel ID for #conversation" },
        channel_updates: { type: "string", description: "Channel ID for #updates" },
        channel_logs: { type: "string", description: "Channel ID for #logs" },
      },
      required: ["guild_id", "channel_conversation", "channel_updates", "channel_logs"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "discord.create_guild",
    name: "create_discord_guild",
    description: "Create a new Discord server (guild) owned by the bot. The bot automatically becomes the server owner — no invite needed. Only works for bots in fewer than 10 servers. Returns the guild ID for use with discord.setup_channels.",
    source: "core",
    category: "discord",
    executor: "local",
    runtime: "internal",
    credentialRequired: "DISCORD_BOT_TOKEN",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Server name (default: 'Agent HQ')" },
      },
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "discord.create_invite",
    name: "create_discord_invite",
    description: "Create an invite link for a Discord channel. Returns the invite URL and a QR code URL the user can scan from their phone to join via the Discord mobile app. By default creates a permanent, unlimited-use invite.",
    source: "core",
    category: "discord",
    executor: "local",
    runtime: "internal",
    credentialRequired: "DISCORD_BOT_TOKEN",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "The channel ID to create the invite for" },
        max_age: { type: "number", description: "Invite expiry in seconds (0 = never, default: 0)" },
        max_uses: { type: "number", description: "Max number of uses (0 = unlimited, default: 0)" },
      },
      required: ["channel_id"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "discord.send_message",
    name: "send_discord_message",
    description: "Send a message to a Discord channel with optional rich embeds and link buttons. Embeds support titles, descriptions, colors, fields, images, and thumbnails. Link buttons appear below the message as clickable URL buttons.",
    source: "core",
    category: "discord",
    executor: "local",
    runtime: "internal",
    credentialRequired: "DISCORD_BOT_TOKEN",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "The Discord channel ID to send the message to" },
        content: { type: "string", description: "The message text to send (supports Discord markdown). Optional if embeds provided." },
        embeds: {
          type: "array",
          description: "Array of embed objects for rich formatting. Each embed can have: title, description, url, color (decimal int, e.g. 5814783 for cyan), fields (array of {name, value, inline?}), image ({url}), thumbnail ({url}), author ({name, url?, icon_url?}), footer ({text, icon_url?}), timestamp (ISO 8601 string)",
          items: { type: "object" },
        },
        link_buttons: {
          type: "array",
          description: "Array of URL link buttons to display below the message. Each button: {label (string, button text), url (string, opens in browser), emoji? (string, optional Unicode emoji before label)}. Max 5 buttons per row, max 5 rows.",
          items: { type: "object" },
        },
        action_buttons: {
          type: "array",
          description: "Array of interactive buttons that trigger actions when clicked. Each button: {label (string), custom_id (string, use 'prompt:your text' to trigger a DotBot prompt), style? ('primary'|'secondary'|'success'|'danger', default: 'primary'), emoji? (string, optional Unicode emoji)}. Max 5 buttons per row, max 5 rows.",
          items: { type: "object" },
        },
      },
      required: ["channel_id"],
    },
    annotations: {},
  },
  {
    id: "discord.send_file",
    name: "send_discord_file",
    description: "Upload a file (image, document, etc.) to a Discord channel with an optional message. Reads the file from the local filesystem and uploads it as an attachment. Supports any file type — images will render inline in Discord. Max file size: 8MB (Discord free tier limit).",
    source: "core",
    category: "discord",
    executor: "local",
    runtime: "internal",
    credentialRequired: "DISCORD_BOT_TOKEN",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "The Discord channel ID to send the file to" },
        file_path: { type: "string", description: "Absolute path to the file to upload" },
        content: { type: "string", description: "Optional message text to send alongside the file" },
      },
      required: ["channel_id", "file_path"],
    },
    annotations: {},
  },
  {
    id: "discord.full_setup",
    name: "full_discord_setup",
    description: "One-shot Discord setup: creates a bot-owned server, sets up #conversation/#updates/#logs channels, generates an invite link + QR code, and writes all config to ~/.bot/.env. Smart resume — detects existing bot-owned server and channels, skips what's already done. Call this AFTER the token is validated with discord.validate_token. Returns the invite URL and QR code for the user to join.",
    source: "core",
    category: "discord",
    executor: "local",
    runtime: "internal",
    credentialRequired: "DISCORD_BOT_TOKEN",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Server name (default: 'Agent HQ')" },
      },
    },
    annotations: { destructiveHint: true },
  },
];

export const llmTools: DotBotTool[] = [
  {
    id: "llm.local_query",
    name: "local_query",
    description: "Send a prompt to the local LLM (Qwen 2.5 0.5B) for simple tasks that don't need a powerful cloud model. Runs entirely on your machine — works even when the server is down. Good for: classification, keyword extraction, summarization of short text, simple formatting, yes/no decisions, labeling, and basic Q&A. NOT suitable for complex reasoning, code generation, or long-form writing. Saves cloud API tokens.",
    source: "core",
    category: "llm",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The prompt to send to the local LLM" },
        system: { type: "string", description: "Optional system prompt to set context (keep short — small model)" },
        max_tokens: { type: "number", description: "Max tokens in response (default: 512, max: 2048)" },
      },
      required: ["prompt"],
    },
    annotations: { readOnlyHint: true },
  },
];

// ============================================
// REMINDER / SCHEDULER TOOLS
// ============================================

export const reminderTools: DotBotTool[] = [
  {
    id: "reminder.set",
    name: "set_reminder",
    description: "Set a reminder for a specific date/time. The reminder will be checked by the heartbeat system (every 5 minutes) and the user will be notified when it's due — including via Discord if configured. Use ISO 8601 format for the time, or natural language that you convert to ISO 8601.",
    source: "core",
    category: "reminder",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The reminder message — what should the user be reminded about" },
        scheduled_for: { type: "string", description: "When to trigger the reminder (ISO 8601 datetime, e.g. '2026-02-10T15:00:00-05:00')" },
        priority: { type: "string", description: "Priority level: P0 (urgent), P1 (important, default), P2 (normal), P3 (low)" },
      },
      required: ["message", "scheduled_for"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "reminder.list",
    name: "list_reminders",
    description: "List all scheduled reminders for the current user. Can filter by status (scheduled, completed, failed, expired).",
    source: "core",
    category: "reminder",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter by status: 'scheduled' (default, pending reminders), 'completed', 'failed', 'expired', or omit for all" },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "reminder.cancel",
    name: "cancel_reminder",
    description: "Cancel a scheduled reminder by its task ID. Only works on reminders that haven't been triggered yet.",
    source: "core",
    category: "reminder",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The reminder/task ID to cancel (from reminder.list)" },
      },
      required: ["task_id"],
    },
    annotations: { destructiveHint: true },
  },
];

// ============================================
// ADMIN TOOLS (server-side, WS-only)
// ============================================

export const adminTools: DotBotTool[] = [
  {
    id: "admin.create_token",
    name: "create_invite_token",
    description: "Generate a new invite token for device registration. Returns the token string (dbot-XXXX-XXXX-XXXX-XXXX format) which must be given to the user who needs to register. The token is single-use by default and expires in 7 days.",
    source: "core",
    category: "admin",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Human-readable label for this token (e.g. 'Alice laptop')" },
        max_uses: { type: "number", description: "How many times this token can be used (default: 1)" },
        expiry_days: { type: "number", description: "Days until token expires (default: 7)" },
      },
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "admin.list_tokens",
    name: "list_invite_tokens",
    description: "List all invite tokens and their status (active, consumed, revoked, expired). Shows usage counts and expiry dates.",
    source: "core",
    category: "admin",
    executor: "local",
    runtime: "internal",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    id: "admin.revoke_token",
    name: "revoke_invite_token",
    description: "Revoke an active invite token so it can no longer be used for device registration.",
    source: "core",
    category: "admin",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "The full invite token string to revoke (dbot-XXXX-XXXX-XXXX-XXXX)" },
      },
      required: ["token"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "admin.list_devices",
    name: "list_registered_devices",
    description: "List all registered devices — shows device ID, label, status, admin flag, registration date, and last seen info.",
    source: "core",
    category: "admin",
    executor: "local",
    runtime: "internal",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    id: "admin.revoke_device",
    name: "revoke_device",
    description: "Revoke a registered device so it can no longer authenticate. The device will need a new invite token to re-register.",
    source: "core",
    category: "admin",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        device_id: { type: "string", description: "The device ID to revoke (dev_XXXX format)" },
      },
      required: ["device_id"],
    },
    annotations: { destructiveHint: true },
  },
];

// ============================================
// EMAIL TOOLS (temp email via mail.tm)
// ============================================

export const emailTools: DotBotTool[] = [
  {
    id: "email.create_temp",
    name: "create_temp_email",
    description: "Create a temporary disposable email address via mail.tm. Returns the address and account ID. Use for signups, verifications, or receiving one-off emails. The address is valid until you delete it or the mail.tm service recycles it. Only one temp email can be active at a time.",
    source: "core",
    category: "email",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        prefix: { type: "string", description: "Optional prefix for the email address (e.g. 'dotbot-signup'). Random if omitted." },
      },
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "email.check_temp_inbox",
    name: "check_temp_inbox",
    description: "Check the inbox of the currently active temp email address. Returns a list of received messages with sender, subject, and timestamp. Use email.read_temp_message to get the full body of a specific message.",
    source: "core",
    category: "email",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number", description: "Page number for pagination (default: 1)" },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "email.read_temp_message",
    name: "read_temp_message",
    description: "Read the full content of a specific temp email message by its ID. Returns the complete body (plain text and HTML), attachments info, and all headers.",
    source: "core",
    category: "email",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "The message ID from email.check_temp_inbox results" },
      },
      required: ["message_id"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "email.delete_temp",
    name: "delete_temp_email",
    description: "Delete the currently active temp email account and all its messages. Use when done with the temp address (e.g. after verifying a signup). Frees the slot so a new temp email can be created.",
    source: "core",
    category: "email",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "email.list_addresses",
    name: "list_email_addresses",
    description: "List all active email addresses — both the identity email (@getmy.bot, if provisioned) and the temp email (mail.tm, if active). Shows address, type, creation time, and message count.",
    source: "core",
    category: "email",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: { readOnlyHint: true },
  },
];
