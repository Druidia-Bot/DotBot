/**
 * Research Tool Definitions (workspace research output)
 */

import type { DotBotTool } from "../../memory/types.js";

export const researchTools: DotBotTool[] = [
  {
    id: "research.save",
    name: "save_research",
    description: `Save structured research output to your agent workspace. Creates a dated research notes file in workspace/research/ with frontmatter metadata, and optionally an executive summary in workspace/output/report.md.

Use this instead of raw filesystem.write_file when saving research — it handles directory creation, frontmatter, naming conventions, and dual-file output automatically.`,
    source: "core",
    category: "research",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Full path to your agent workspace (e.g. ~/.bot/agent-workspaces/agent_XXX)" },
        title: { type: "string", description: "Short descriptive title for the research (e.g. 'LYFT Stock Analysis')" },
        type: { type: "string", description: "Research type: market-analysis, news-summary, general-research, competitive-analysis, technical-research" },
        detailed_notes: { type: "string", description: "Full markdown research notes — sources, methodology, findings, raw data, analysis" },
        executive_summary: { type: "string", description: "Brief 2-3 paragraph summary with key takeaways and recommendations (saved to output/report.md)" },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags for categorization" },
        metadata: { type: "object", description: "Optional structured metadata (e.g. { ticker: 'LYFT', sector: 'Transportation' })" },
      },
      required: ["workspace", "title", "detailed_notes"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "research.list",
    name: "list_research",
    description: "List existing research files in your agent workspace. Shows titles, types, dates, tags, and file sizes. Use this BEFORE starting new research to check if previous work exists that you can build on.",
    source: "core",
    category: "research",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Full path to your agent workspace (e.g. ~/.bot/agent-workspaces/agent_XXX)" },
      },
      required: ["workspace"],
    },
    annotations: { readOnlyHint: true },
  },
];
