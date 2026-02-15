/**
 * Server-Side Core Tool Registry
 *
 * Canonical list of all built-in tool definitions with platform
 * and runtime requirements. The server owns the "what exists and who
 * can use it" — the client owns execution (HOW to run tools).
 *
 * This registry enables:
 * 1. Platform-aware filtering (drop Linux-only tools on Windows, etc.)
 * 2. Runtime-aware filtering (drop tools requiring unavailable runtimes)
 * 3. Receptionist tool selection without a connected client
 * 4. Validation of client-reported manifests
 *
 * Tool definitions are organized by platform for better manageability:
 * - windows-only.ts: Windows-specific tools (WIN platform)
 * - cross-platform.ts: Desktop tools (DESKTOP platform - Win/Linux/macOS)
 * - universal.ts: All platform tools (ALL - including web, server-executed)
 */

import type { Platform } from "./types.js";
import type { ToolDefinition } from "#llm/types.js";
import { WINDOWS_ONLY_TOOLS } from "./definitions/windows-only.js";
import { CROSS_PLATFORM_TOOLS } from "./definitions/cross-platform.js";
import { UNIVERSAL_TOOLS } from "./definitions/universal.js";

export { memoryTools } from "./definitions/universal.js";

// ============================================
// TYPES
// ============================================

export interface CoreToolDefinition {
  id: string;
  name: string;
  description: string;
  category: string;
  inputSchema: Record<string, any>;
  /** Platforms this tool supports. */
  platforms: Platform[];
  /** Runtimes required on the client (e.g., ["powershell"], ["python"]). */
  requiredRuntimes?: string[];
  /** Where the tool runs: "client" (local-agent) or "server" (server-side). */
  executor: "client" | "server";
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    requiresConfirmation?: boolean;
    longRunningHint?: boolean;
    costHint?: boolean;
    costCredits?: number;
  };
  /** Credential vault key required (e.g., "BRAVE_SEARCH_API_KEY"). */
  credentialRequired?: string;
}

// ============================================
// COMBINED REGISTRY
// ============================================

/**
 * All core tool definitions organized by platform:
 * 1. Windows-only (WIN) - 52 tools
 * 2. Cross-platform desktop (DESKTOP) - 119 tools
 * 3. Universal (ALL) - 8 tools
 *
 * Total: 174 tools across 37 categories
 */
export const CORE_TOOLS: CoreToolDefinition[] = [
  // Windows-only tools (WIN platform)
  ...WINDOWS_ONLY_TOOLS,

  // Cross-platform desktop tools (DESKTOP platform: Windows, Linux, macOS)
  ...CROSS_PLATFORM_TOOLS,

  // Universal tools (ALL platforms including web - server-executed)
  ...UNIVERSAL_TOOLS,
];

// ============================================
// LOOKUP FUNCTIONS
// ============================================

/** Index by ID for fast lookup. */
const toolIndex = new Map<string, CoreToolDefinition>();
for (const tool of CORE_TOOLS) {
  toolIndex.set(tool.id, tool);
}

/** Get a core tool definition by ID. */
export function getCoreToolById(id: string): CoreToolDefinition | undefined {
  return toolIndex.get(id);
}

/** Get all core tools in a category. */
export function getCoreToolsByCategory(category: string): CoreToolDefinition[] {
  return CORE_TOOLS.filter(t => t.category === category);
}

/** Get all unique categories. */
export function getCoreCategories(): string[] {
  return [...new Set(CORE_TOOLS.map(t => t.category))];
}

/** Get tool count. */
export function getCoreToolCount(): number {
  return CORE_TOOLS.length;
}

/** Get tools by platform. */
export function getCoreToolsByPlatform(platform: Platform): CoreToolDefinition[] {
  return CORE_TOOLS.filter(t => t.platforms.includes(platform));
}

/** Get platform summary statistics. */
export function getPlatformStats() {
  return {
    windows: WINDOWS_ONLY_TOOLS.length,
    crossPlatform: CROSS_PLATFORM_TOOLS.length,
    universal: UNIVERSAL_TOOLS.length,
    total: CORE_TOOLS.length,
  };
}

/**
 * Convert core tool definitions to native LLM ToolDefinition[] format.
 * Tool IDs are sanitized (dots → __) to comply with function name restrictions.
 */
export function coreToolsToNative(tools: CoreToolDefinition[]): ToolDefinition[] {
  return tools.map(t => ({
    type: "function" as const,
    function: {
      name: t.id.replace(/\./g, "__"),
      description: t.description,
      parameters: {
        type: "object",
        properties: t.inputSchema?.properties || {},
        required: t.inputSchema?.required || [],
      },
    },
  }));
}
