/**
 * Tool Handler — knowledge.search
 *
 * Searches the local knowledge base via tool execution on the local agent.
 * Tracks results in ctx.state.
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "../../logging.js";
import { sendExecutionCommand } from "../../ws/device-bridge.js";
import type { ToolContext } from "../types.js";

const log = createComponentLogger("tool-loop.knowledge.search");

export async function handleKnowledgeSearch(ctx: ToolContext, args: Record<string, any>): Promise<string> {
  try {
    const raw = await sendExecutionCommand(ctx.deviceId, {
      id: `tl_ksearch_${nanoid(6)}`,
      type: "tool_execute",
      payload: {
        toolId: "knowledge.search",
        toolArgs: { query: args.query || "" },
      },
      dryRun: false,
      timeout: 15_000,
      sandboxed: false,
      requiresApproval: false,
    });

    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    const entries: any[] = Array.isArray(parsed) ? parsed : parsed?.results || [];

    // Track every search attempt (even zero-result ones)
    if (typeof ctx.state.knowledgeSearchCount === "number") ctx.state.knowledgeSearchCount++;

    if (entries.length > 0) {
      const content = entries
        .slice(0, 5)
        .map((r: any) => `- **${r.title || r.filename || "doc"}**: ${String(r.snippet || r.content || "").slice(0, 300)}`)
        .join("\n");

      const knowledgeGathered: { query: string; content: string }[] = ctx.state.knowledgeGathered || [];
      knowledgeGathered.push({ query: args.query, content });
      ctx.state.knowledgeGathered = knowledgeGathered;

      log.info("knowledge.search", { query: args.query, results: entries.length });
      return `Found ${entries.length} knowledge result(s):\n${content}`;
    }

    log.info("knowledge.search", { query: args.query, results: 0 });
    return raw || `No knowledge results for "${args.query}".`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("knowledge.search failed", { query: args.query, error: msg });
    return `Knowledge search failed: ${msg}`;
  }
}
