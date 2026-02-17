/**
 * Journal — Structured Fallback
 *
 * Generates a structured journal section when the LLM narrator
 * is unavailable. Uses actual content excerpts rather than just metadata.
 */

import type { CacheEntry } from "../research-cache.js";

/**
 * Build a structured journal section without an LLM call.
 * Each entry gets a time header, type label, content excerpt, and tags.
 */
export function buildStructuredFallback(entries: CacheEntry[], contents: Map<string, string>): string {
  const lines: string[] = [];

  for (const entry of entries) {
    const time = entry.cachedAt.slice(11, 16);
    const title = entry.title || entry.source;
    const content = contents.get(entry.filename);

    lines.push(`### ${time} — ${title}`);
    lines.push(`> ${entry.type.replace(/_/g, " ")} via \`${entry.tool}\``);

    if (content) {
      const excerpt = content.length > 500
        ? content.slice(0, 500) + "..."
        : content;
      lines.push("");
      lines.push(excerpt);
    } else if (entry.brief) {
      lines.push("");
      lines.push(entry.brief);
    }

    if (entry.tags?.length) {
      lines.push("");
      lines.push(`**Tags:** ${entry.tags.join(", ")}`);
    }

    lines.push("");
    lines.push(`_Source: ${entry.source}_`);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}
