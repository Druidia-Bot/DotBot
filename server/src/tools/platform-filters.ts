/**
 * Platform Filters — V2 Tool Filtering by Platform & Runtime
 *
 * Filters the core tool registry (or a client manifest) based on
 * the connecting device's platform and available runtimes.
 *
 * Flow:
 * 1. Client connects with { platform, runtimes }
 * 2. Server filters core tools → available tools for this device
 * 3. Client-reported custom/API tools are merged in
 * 4. Result: DeviceToolManifest stored per device
 */

import type { Platform, ToolManifestEntry } from "../agents/tools.js";
import { CORE_TOOLS, type CoreToolDefinition } from "./core-registry.js";

// ============================================
// FILTERING
// ============================================

/**
 * Filter core tools by platform and available runtimes.
 * Returns only tools that can run on the given platform
 * with the given runtimes.
 */
export function filterCoreTools(
  platform: Platform,
  runtimes: string[]
): CoreToolDefinition[] {
  const runtimeSet = new Set(runtimes.map(r => r.toLowerCase()));

  return CORE_TOOLS.filter(tool => {
    // Platform check
    if (!tool.platforms.includes(platform)) return false;

    // Runtime check — if tool requires specific runtimes, all must be present
    if (tool.requiredRuntimes && tool.requiredRuntimes.length > 0) {
      for (const req of tool.requiredRuntimes) {
        if (!runtimeSet.has(req.toLowerCase())) return false;
      }
    }

    return true;
  });
}

/**
 * Filter a client-reported manifest against known platform rules.
 * Uses the core registry to validate/enrich platform data.
 * Client-reported tools NOT in the core registry (custom/API tools)
 * are passed through unfiltered.
 */
export function filterManifest(
  manifest: ToolManifestEntry[],
  platform: Platform,
  runtimes: string[]
): ToolManifestEntry[] {
  const allowedCoreIds = new Set(
    filterCoreTools(platform, runtimes).map(t => t.id)
  );

  return manifest.filter(entry => {
    // Core tools: use our registry's platform rules
    const coreTool = CORE_TOOLS.find(t => t.id === entry.id);
    if (coreTool) {
      return allowedCoreIds.has(entry.id);
    }
    // Custom/API/MCP tools: trust client-reported platforms
    if (entry.platforms && entry.platforms.length > 0) {
      return entry.platforms.includes(platform);
    }
    // No platform info → allow by default (desktop tools)
    return platform !== "web";
  });
}

/**
 * Merge a client manifest with server-side tool definitions.
 * Client manifest takes precedence for descriptions and schemas
 * (since they may be more detailed). Server adds platform/runtime
 * metadata where the client lacks it.
 */
export function mergeWithCoreRegistry(
  clientManifest: ToolManifestEntry[]
): ToolManifestEntry[] {
  const clientIds = new Set(clientManifest.map(e => e.id));
  const merged = [...clientManifest];

  // Add any core tools the client didn't report
  // (server-executed tools that don't need a local agent)
  for (const core of CORE_TOOLS) {
    if (!clientIds.has(core.id) && core.executor === "server") {
      merged.push({
        id: core.id,
        name: core.name,
        description: core.description,
        category: core.category,
        inputSchema: core.inputSchema as any,
        annotations: core.annotations as any,
        platforms: core.platforms,
        credentialRequired: core.credentialRequired,
      });
    }
  }

  return merged;
}

/**
 * Get the executor type for a tool ("client" or "server").
 * Used to route tool execution to the right place.
 */
export function getToolExecutor(toolId: string): "client" | "server" | undefined {
  const core = CORE_TOOLS.find(t => t.id === toolId);
  return core?.executor;
}

/**
 * Check if a tool requires a specific credential.
 */
export function getToolCredential(toolId: string): string | undefined {
  const core = CORE_TOOLS.find(t => t.id === toolId);
  return core?.credentialRequired;
}
