/**
 * Tool Handler — memory.search
 *
 * Searches across memory models by keyword. Tracks results in ctx.state.
 */

import { createComponentLogger } from "#logging.js";
import { sendMemoryRequest } from "#ws/device-bridge.js";
import type { ToolContext } from "../types.js";

const log = createComponentLogger("tool-loop.memory.search");

export async function handleMemorySearch(ctx: ToolContext, args: Record<string, any>): Promise<string> {
  const res = await sendMemoryRequest(ctx.deviceId, {
    action: "search_models",
    data: { query: args.query || "", includeDeep: true },
  } as any);

  if (Array.isArray(res) && res.length > 0) {
    const content = res
      .slice(0, 5)
      .map((r: any) => `- **${r.name}** (${r.category}): ${r.summary || r.matchReason || ""}`)
      .join("\n");

    const knowledgeGathered: { query: string; content: string }[] = ctx.state.knowledgeGathered || [];
    knowledgeGathered.push({ query: args.query, content });
    ctx.state.knowledgeGathered = knowledgeGathered;

    log.info("search_knowledge", { query: args.query, results: res.length });
    return `Found ${res.length} result(s):\n${content}`;
  }

  log.info("search_knowledge", { query: args.query, results: 0 });
  return `No results for "${args.query}".`;
}
