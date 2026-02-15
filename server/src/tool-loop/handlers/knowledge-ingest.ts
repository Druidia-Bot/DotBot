/**
 * Tool Handler — knowledge.ingest
 *
 * Processes a URL, local file, or archive into structured JSON knowledge
 * using Gemini. This is a server-executed tool — the handler delegates
 * to the server-side ingest callback if available in ctx.state, otherwise
 * falls back to sending via the local agent execution command.
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "../../logging.js";
import { sendExecutionCommand } from "../../ws/device-bridge.js";
import type { ToolContext } from "../types.js";

const log = createComponentLogger("tool-loop.knowledge.ingest");

export async function handleKnowledgeIngest(ctx: ToolContext, args: Record<string, any>): Promise<string> {
  // Prefer server-side ingest callback if the caller provided one
  const serverIngest = ctx.state.executeKnowledgeIngest as
    | ((toolId: string, args: Record<string, any>) => Promise<{ success: boolean; output: string; error?: string }>)
    | undefined;

  if (serverIngest) {
    try {
      const result = await serverIngest("knowledge.ingest", args);
      log.info("knowledge.ingest (server)", { source: args.source, success: result.success });
      if (!result.success) return `Knowledge ingestion failed: ${result.error || "unknown error"}`;
      return result.output;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("knowledge.ingest (server) threw", { source: args.source, error: msg });
      return `Knowledge ingestion failed: ${msg}`;
    }
  }

  // Fallback: send as execution command to local agent
  try {
    const raw = await sendExecutionCommand(ctx.deviceId, {
      id: `tl_kingest_${nanoid(6)}`,
      type: "tool_execute",
      payload: {
        toolId: "knowledge.ingest",
        toolArgs: { source: args.source || "" },
      },
      dryRun: false,
      timeout: 120_000,
      sandboxed: false,
      requiresApproval: false,
    });

    log.info("knowledge.ingest (client fallback)", { source: args.source });
    return raw || "Knowledge ingestion completed.";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("knowledge.ingest failed", { source: args.source, error: msg });
    return `Knowledge ingestion failed: ${msg}`;
  }
}
