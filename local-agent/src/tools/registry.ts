/**
 * Tool Registry
 * 
 * Loads and manages all available tools:
 * - Core tools (built-in)
 * - Custom tools from ~/.bot/tools/custom/
 * - API tools from ~/.bot/tools/api/
 * - (Future) MCP tools from ~/.bot/mcp/ servers
 * 
 * Provides the tool manifest for the server to generate prompts,
 * and resolves tool IDs for execution.
 */

import { promises as fs } from "fs";
import { resolve, join } from "path";
import { CORE_TOOLS } from "./core-tools.js";
import { isRuntimeAvailable, getDetectedRuntimes } from "./tool-executor.js";
import type { RuntimeInfo } from "./tool-executor.js";
import type { DotBotTool, ToolManifestEntry } from "../memory/types.js";
import { vaultHas } from "../credential-vault.js";

// ============================================
// REGISTRY STATE
// ============================================

const toolMap = new Map<string, DotBotTool>();
let initialized = false;

// ============================================
// INITIALIZATION
// ============================================

/**
 * Initialize the tool registry. Loads core tools immediately,
 * then loads custom/API tools from ~/.bot/tools/.
 */
export async function initToolRegistry(): Promise<void> {
  // Load core tools
  for (const tool of CORE_TOOLS) {
    toolMap.set(tool.id, tool);
  }

  // Load custom and API tools from disk
  const botDir = resolve(process.env.USERPROFILE || process.env.HOME || "", ".bot");
  await loadToolsFromDir(join(botDir, "tools", "api"), "api");
  await loadToolsFromDir(join(botDir, "tools", "custom"), "custom");

  initialized = true;
  console.log(`[ToolRegistry] Initialized with ${toolMap.size} tools (${CORE_TOOLS.length} core)`);
}

/**
 * Load tool definition JSON files from a directory.
 */
async function loadToolsFromDir(dir: string, source: "api" | "custom"): Promise<void> {
  try {
    await fs.access(dir);
  } catch {
    return; // Directory doesn't exist yet
  }

  try {
    const files = await fs.readdir(dir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = await fs.readFile(join(dir, file), "utf-8");
        const tool = JSON.parse(content) as DotBotTool;
        // Ensure source is correct
        tool.source = source;
        if (tool.id && tool.name) {
          toolMap.set(tool.id, tool);
          console.log(`[ToolRegistry] Loaded ${source} tool: ${tool.id}`);
        }
      } catch (err) {
        console.warn(`[ToolRegistry] Failed to load tool from ${file}:`, err);
      }
    }
  } catch (err) {
    console.warn(`[ToolRegistry] Failed to read tools directory ${dir}:`, err);
  }
}

// ============================================
// QUERIES
// ============================================

/**
 * Get a tool by its ID.
 */
export function getTool(id: string): DotBotTool | undefined {
  return toolMap.get(id);
}

/**
 * Get all registered tools.
 */
export function getAllTools(): DotBotTool[] {
  return Array.from(toolMap.values());
}

/**
 * Get tools by category.
 */
export function getToolsByCategory(category: string): DotBotTool[] {
  return getAllTools().filter(t => t.category === category);
}

/** Map tool runtime to the detected runtime name. */
const runtimeToDetected: Record<string, string> = {
  python: "python",
  node: "node",
  powershell: "powershell",
};

/** Check if a tool's required runtime is available. */
function isToolAvailable(tool: DotBotTool): boolean {
  if (!tool.runtime) return true; // No runtime requirement
  const detectedName = runtimeToDetected[tool.runtime];
  if (!detectedName) return true; // http, mcp, internal — always available
  return isRuntimeAvailable(detectedName);
}

/**
 * Get the lightweight manifest for the server.
 * Only includes tools whose required runtime is available.
 * Includes credential metadata (reference names + configured boolean) — never actual values.
 */
export async function getToolManifest(): Promise<ToolManifestEntry[]> {
  const tools = getAllTools().filter(isToolAvailable);
  const entries: ToolManifestEntry[] = [];

  for (const t of tools) {
    const entry: ToolManifestEntry = {
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    };

    // Include credential metadata — reference name only, never the value
    if (t.credentialRequired) {
      entry.credentialRequired = t.credentialRequired;
      entry.credentialConfigured = await vaultHas(t.credentialRequired);
    }

    entries.push(entry);
  }

  return entries;
}

/**
 * Get runtime environment info for the server to include in system context.
 */
export function getRuntimeManifest(): RuntimeInfo[] {
  return getDetectedRuntimes();
}

/**
 * Register a tool at runtime (e.g., from MCP server discovery).
 */
export function registerTool(tool: DotBotTool): void {
  toolMap.set(tool.id, tool);
  console.log(`[ToolRegistry] Registered tool: ${tool.id} (${tool.source})`);
}

/**
 * Unregister a tool by ID.
 */
export function unregisterTool(id: string): boolean {
  return toolMap.delete(id);
}
