/**
 * Journal — Identity Loader
 *
 * Loads the agent's name, identity skeleton, and backstory
 * so the journal narrator can write in the agent's voice.
 */

import { promises as fs } from "fs";
import { join } from "path";
import { loadIdentity, buildIdentitySkeleton } from "../store-identity.js";
import { DOTBOT_DIR } from "../store-core.js";
import type { AgentContext } from "./types.js";

/**
 * Load the agent's identity context for journal writing.
 * Returns name, skeleton, and backstory (if enabled).
 * Falls back to defaults if identity can't be loaded.
 */
export async function getAgentContext(): Promise<AgentContext> {
  let name = "Dot";
  let skeleton = "Name: Dot\nRole: AI Assistant";
  let backstory: string | null = null;

  try {
    const identity = await loadIdentity();
    if (identity) {
      name = identity.name;
      skeleton = buildIdentitySkeleton(identity);

      if (identity.useBackstory) {
        try {
          const backstoryPath = join(DOTBOT_DIR, "backstory.md");
          backstory = await fs.readFile(backstoryPath, "utf-8");
        } catch { /* no backstory file */ }
      }
    }
  } catch { /* identity load failed */ }

  return { name, skeleton, backstory };
}
