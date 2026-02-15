/**
 * Tool Handler — knowledge.delete
 *
 * Deletes a knowledge document by filename.
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "#logging.js";
import { sendExecutionCommand } from "#ws/device-bridge.js";
import type { ToolContext } from "../types.js";

const log = createComponentLogger("tool-loop.knowledge.delete");

export async function handleKnowledgeDelete(ctx: ToolContext, args: Record<string, any>): Promise<string> {
  try {
    const raw = await sendExecutionCommand(ctx.deviceId, {
      id: `tl_kdel_${nanoid(6)}`,
      type: "tool_execute",
      payload: {
        toolId: "knowledge.delete",
        toolArgs: {
          filename: args.filename || "",
          persona_slug: args.persona_slug,
        },
      },
      dryRun: false,
      timeout: 15_000,
      sandboxed: false,
      requiresApproval: false,
    });

    log.info("knowledge.delete", { filename: args.filename });
    return raw || `Deleted "${args.filename}".`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("knowledge.delete failed", { filename: args.filename, error: msg });
    return `Knowledge delete failed: ${msg}`;
  }
}
