/**
 * Tool Handler — knowledge.read
 *
 * Reads a knowledge document. Use section parameter for specific keys.
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "../../logging.js";
import { sendExecutionCommand } from "../../ws/device-bridge.js";
import type { ToolContext } from "../types.js";

const log = createComponentLogger("tool-loop.knowledge.read");

export async function handleKnowledgeRead(ctx: ToolContext, args: Record<string, any>): Promise<string> {
  try {
    const raw = await sendExecutionCommand(ctx.deviceId, {
      id: `tl_kread_${nanoid(6)}`,
      type: "tool_execute",
      payload: {
        toolId: "knowledge.read",
        toolArgs: {
          filename: args.filename || "",
          section: args.section,
          persona_slug: args.persona_slug,
        },
      },
      dryRun: false,
      timeout: 15_000,
      sandboxed: false,
      requiresApproval: false,
    });

    log.info("knowledge.read", { filename: args.filename, section: args.section });
    return raw || `(Empty result for "${args.filename}")`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("knowledge.read failed", { filename: args.filename, error: msg });
    return `Knowledge read failed: ${msg}`;
  }
}
