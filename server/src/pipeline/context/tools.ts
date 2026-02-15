/**
 * Context — Tool Manifest Fetching
 *
 * Fetches the tool manifest from the local agent and augments
 * it with server-side premium and imagegen tools.
 */

import { createComponentLogger } from "#logging.js";
import { requestTools } from "#ws/device-bridge.js";

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
    log.info(`Added ${PREMIUM_TOOLS.length} premium + ${IMAGEGEN_TOOLS.length} imagegen tools to manifest (total: ${toolManifest.length})`);

    return { toolManifest, runtimeInfo };
  } catch (err) {
    log.warn("Failed to fetch tool manifest from local agent", { error: err });
    return { toolManifest: [], runtimeInfo: [] };
  }
}
