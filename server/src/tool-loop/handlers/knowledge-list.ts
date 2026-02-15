/**
 * Tool Handler — knowledge.list
 *
 * Lists saved knowledge documents with structural skeletons.
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "#logging.js";
import { sendExecutionCommand } from "#ws/device-bridge.js";
import type { ToolContext } from "../types.js";

const log = createComponentLogger("tool-loop.knowledge.list");

export async function handleKnowledgeList(ctx: ToolContext, args: Record<string, any>): Promise<string> {
  try {
    const raw = await sendExecutionCommand(ctx.deviceId, {
      id: `tl_klist_${nanoid(6)}`,
      type: "tool_execute",
      payload: {
        toolId: "knowledge.list",
        toolArgs: { persona_slug: args.persona_slug },
      },
      dryRun: false,
      timeout: 15_000,
      sandboxed: false,
      requiresApproval: false,
    });

    log.info("knowledge.list", { persona_slug: args.persona_slug });
    return raw || "(No knowledge documents found)";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("knowledge.list failed", { error: msg });
    return `Knowledge list failed: ${msg}`;
  }
}
