/**
 * tools.list_tools — Unified Tool Listing Handler
 *
 * Merges tools from two sources into a single response:
 *   1. Local-agent tools (proxied via WebSocket)
 *   2. Server tools — shared definitions + manifest-driven dynamic tools
 *
 * Extracted into its own file so both Dot's builder and the pipeline
 * step executor can import and register it.
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "#logging.js";
import { sendExecutionCommand } from "#ws/device-bridge.js";
import { SHARED_SERVER_TOOLS } from "#tools/definitions/server-tools.js";
import { getMcpManifestEntries, getMcpConnectionStatus } from "../../mcp/index.js";
import type { ToolHandler, ToolContext } from "../types.js";
import type { ToolManifestEntry } from "#tools/types.js";

const log = createComponentLogger("tool-loop.tools-list");

const DYNAMIC_CATS = new Set(["premium", "imagegen", "schedule"]);

interface SimpleTool { id: string; description: string; category: string }

/**
 * Build a tools.list_tools handler that merges all tool sources.
 * Call this with the current manifest and register the returned handler.
 */
export function buildToolsListHandler(manifest: ToolManifestEntry[]): ToolHandler {
  const serverDynamicTools = manifest.filter(t => DYNAMIC_CATS.has(t.category));

  return async (ctx: ToolContext, args: Record<string, any>) => {
    const category = args.category as string | undefined;
    const source = args.source as string | undefined;

    const sections: string[] = [];

    // ── 1. Local-agent tools (proxy) ──
    if (!source || source === "local") {
      let localOutput = "";
      try {
        localOutput = await sendExecutionCommand(ctx.deviceId, {
          id: `proxy_${nanoid(8)}`,
          type: "tool_execute",
          payload: {
            toolId: "tools.list_tools",
            toolArgs: { ...(category && { category }), ...(source && { source }) },
          },
          dryRun: false,
          timeout: 30_000,
          sandboxed: false,
          requiresApproval: false,
        });
      } catch {
        localOutput = "(Could not reach local agent)";
      }
      if (localOutput) {
        sections.push("## Local Agent Tools\n" + localOutput);
      }
    }

    // ── 2. Server tools (shared definitions + manifest-driven dynamic) ──
    if (!source || source === "server") {
      // Merge both sources into one flat list
      const allServerTools: SimpleTool[] = [
        ...SHARED_SERVER_TOOLS.map(t => ({ id: t.id, description: t.description, category: t.category })),
        ...serverDynamicTools.map(t => ({ id: t.id, description: t.description, category: t.category })),
      ];

      const matching = category
        ? allServerTools.filter(t => t.category === category)
        : allServerTools;

      if (matching.length > 0) {
        const grouped = new Map<string, SimpleTool[]>();
        for (const t of matching) {
          if (!grouped.has(t.category)) grouped.set(t.category, []);
          grouped.get(t.category)!.push(t);
        }

        const lines: string[] = [];
        for (const [cat, catTools] of grouped) {
          lines.push(`[${cat}] (${catTools.length})`);
          for (const t of catTools) {
            const desc = t.description.length > 80 ? t.description.substring(0, 80) + "..." : t.description;
            lines.push(`  ${t.id} — ${desc} (server)`);
          }
        }
        sections.push(`## Server Tools (${matching.length})\n` + lines.join("\n"));
      }
    }

    // ── 3. MCP gateway tools (credentialed servers connected server-side) ──
    const mcpEntries = getMcpManifestEntries(ctx.deviceId);
    const mcpStatus = getMcpConnectionStatus(ctx.deviceId);

    if (mcpEntries.length > 0) {
      const mcpTools: SimpleTool[] = mcpEntries.map(t => ({ id: t.id, description: t.description, category: t.category }));
      const matching = category
        ? mcpTools.filter(t => t.category === category || t.id.startsWith(category + "."))
        : mcpTools;

      if (matching.length > 0) {
        const grouped = new Map<string, SimpleTool[]>();
        for (const t of matching) {
          if (!grouped.has(t.category)) grouped.set(t.category, []);
          grouped.get(t.category)!.push(t);
        }
        const lines: string[] = [];
        for (const [cat, catTools] of grouped) {
          lines.push(`[${cat}] (${catTools.length})`);
          for (const t of catTools) {
            const desc = t.description.length > 80 ? t.description.substring(0, 80) + "..." : t.description;
            lines.push(`  ${t.id} — ${desc} (mcp-gateway)`);
          }
        }
        sections.push(`## MCP Gateway Tools (${matching.length})\n` + lines.join("\n"));
      }
    }

    // Show MCP connection errors (even when no tools discovered)
    const failedMcp = mcpStatus.filter(s => s.error);
    if (failedMcp.length > 0) {
      const errorLines = failedMcp.map(s => `  ${s.name}: ${s.error}`);
      sections.push(`## MCP Gateway Errors (${failedMcp.length})\n` + errorLines.join("\n"));
    }

    if (sections.length === 0) {
      return "No tools found matching the filter.";
    }

    return sections.join("\n\n");
  };
}
