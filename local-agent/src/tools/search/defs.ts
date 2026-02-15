/**
 * Search Tool Definitions
 */

import type { DotBotTool } from "../../memory/types.js";

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
