/**
 * Research Categories — Tool Classification
 *
 * Identifies which tools produce research-heavy output that should
 * be persisted to the workspace and potentially summarized.
 */

/** Tool categories whose results should be persisted to workspace. */
export const RESEARCH_CATEGORIES = new Set(["search", "http", "market", "research"]);

/** Max characters per tool result before truncation + summarization kicks in. */
export const MAX_TOOL_RESULT_CHARS = 8_000;

/**
 * Check if a tool ID belongs to a research-heavy category.
 */
export function isResearchTool(toolId: string, categoryMap?: Map<string, string>): boolean {
  if (categoryMap) {
    const cat = categoryMap.get(toolId);
    if (cat && RESEARCH_CATEGORIES.has(cat)) return true;
  }
  const prefix = toolId.split(".")[0];
  return RESEARCH_CATEGORIES.has(prefix);
}
