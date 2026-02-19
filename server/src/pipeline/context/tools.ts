/**
 * Context — Tool Manifest Fetching
 *
 * Fetches the tool manifest from the local agent and augments
 * it with server-side premium, imagegen, and MCP gateway tools.
 */

import { createComponentLogger } from "#logging.js";
import { requestTools } from "#ws/device-bridge.js";
import { getMcpManifestEntries } from "../../mcp/index.js";

const log = createComponentLogger("context.tools");

export interface ToolManifestResult {
  toolManifest: any[];
  runtimeInfo: any[];
}

export async function fetchToolManifest(deviceId: string): Promise<ToolManifestResult> {
  try {
    const result = await requestTools(deviceId);
    let toolManifest: any[] = [];
    let runtimeInfo: any[] = [];

    if (result && Array.isArray(result.tools)) {
      toolManifest = result.tools;
      runtimeInfo = result.runtimes || [];
      log.info(`Fetched tool manifest: ${toolManifest.length} tools, ${runtimeInfo.length} runtimes`);
    }

    const { PREMIUM_TOOLS } = await import("#tools-server/premium/manifest.js");
    const { IMAGEGEN_TOOLS } = await import("#tools-server/imagegen/manifest.js");
    toolManifest = [...toolManifest, ...PREMIUM_TOOLS, ...IMAGEGEN_TOOLS];

    // Merge MCP gateway tools (credentialed servers connected server-side)
    const mcpTools = getMcpManifestEntries(deviceId);
    if (mcpTools.length > 0) {
      toolManifest = [...toolManifest, ...mcpTools];
      log.info(`Added ${mcpTools.length} MCP gateway tool(s) to manifest`);
    }

    log.info(`Tool manifest ready: ${toolManifest.length} total tools`);

    return { toolManifest, runtimeInfo };
  } catch (err) {
    log.warn("Failed to fetch tool manifest from local agent", { error: err });
    return { toolManifest: [], runtimeInfo: [] };
  }
}
