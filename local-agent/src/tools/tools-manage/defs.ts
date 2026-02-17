/**
 * Tools Management (Self-Learning) Definitions
 */

import type { DotBotTool } from "../../memory/types.js";

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
        mutating: { type: "boolean", description: "Does this tool modify external state? true = mutating (write, create, delete, send), false = read-only/verification. Defaults to true if omitted." },
        cache: {
          type: "object",
          description: "Research cache config. If set, successful results are cached for follow-up questions. mode: 'raw' (already structured, e.g. search results) or 'enrich' (needs LLM summary, e.g. web pages, transcripts). type: 'web_page', 'web_search', 'api_response', 'pdf_summary', 'video_transcript', or 'image_description'. Auto-inferred as { mode: 'raw', type: 'api_response' } for read-only API tools if omitted.",
          properties: {
            mode: { type: "string", enum: ["raw", "enrich"] },
            type: { type: "string", enum: ["web_page", "web_search", "api_response", "pdf_summary", "video_transcript", "image_description"] },
          },
        },
      },
      required: ["id", "name", "description", "category", "inputSchema"],
    },
    annotations: { destructiveHint: true, mutatingHint: true },
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
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
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
    annotations: { destructiveHint: true, mutatingHint: true },
  },
];
