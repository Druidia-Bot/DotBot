/**
 * Compact Tool Catalog
 *
 * Generates a compact representation of all available tools for the
 * receptionist/orchestrator. Instead of full JSON schemas (~40K tokens),
 * the catalog shows tool ID + one-line description (~3-5K tokens for 140 tools).
 *
 * The receptionist uses this to pick specific tool IDs for each agent,
 * replacing the old category-count summary that was too vague for good routing.
 */

import type { ToolManifestEntry } from "../agents/tools.js";

/**
 * A single entry in the compact catalog.
 * Just enough for the receptionist to understand what the tool does.
 */
export interface CatalogEntry {
  id: string;
  description: string;
  category: string;
}

/**
 * Generate a compact tool catalog from the device's tool manifest.
 * Returns a markdown string with tool IDs and one-line descriptions,
 * grouped by category. Designed to be injected into the receptionist's
 * system prompt.
 *
 * ~3-5K tokens for 120-140 tools (vs ~40K for full schemas).
 */
export function generateCompactCatalog(manifest: ToolManifestEntry[]): string {
  if (!manifest || manifest.length === 0) return "No tools available.";

  // Group by category
  const grouped = new Map<string, ToolManifestEntry[]>();
  for (const t of manifest) {
    const cat = t.category || "general";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(t);
  }

  // Build compact listing
  const lines: string[] = ["## Available Tools\n"];

  for (const [category, tools] of grouped) {
    lines.push(`### ${category} (${tools.length})`);
    for (const t of tools) {
      // Truncate description to first sentence for compactness
      const desc = truncateDescription(t.description);
      const credNote = t.credentialRequired
        ? t.credentialConfigured ? " [cred: ok]" : " [cred: needed]"
        : "";
      lines.push(`- \`${t.id}\`: ${desc}${credNote}`);
    }
    lines.push("");
  }

  lines.push(`**Total: ${manifest.length} tools**`);
  return lines.join("\n");
}

/**
 * Generate an even more compact catalog — just IDs grouped by category.
 * Useful when token budget is extremely tight (~500 tokens for 140 tools).
 */
export function generateMinimalCatalog(manifest: ToolManifestEntry[]): string {
  if (!manifest || manifest.length === 0) return "No tools available.";

  const grouped = new Map<string, string[]>();
  for (const t of manifest) {
    const cat = t.category || "general";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(t.id);
  }

  const lines: string[] = [];
  for (const [category, ids] of grouped) {
    lines.push(`**${category}**: ${ids.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Get catalog entries as structured data (for JSON injection).
 */
export function getCatalogEntries(manifest: ToolManifestEntry[]): CatalogEntry[] {
  return manifest.map(t => ({
    id: t.id,
    description: truncateDescription(t.description),
    category: t.category || "general",
  }));
}

/**
 * Filter a manifest to only the specified tool IDs.
 * Used after the receptionist picks tools for an agent.
 */
export function sliceManifest(
  manifest: ToolManifestEntry[],
  selectedIds: string[]
): ToolManifestEntry[] {
  const idSet = new Set(selectedIds);
  return manifest.filter(t => idSet.has(t.id));
}

/**
 * Truncate a tool description to its first sentence.
 * Keeps the catalog compact without losing the key information.
 */
function truncateDescription(description: string): string {
  // Find first sentence end (. followed by space or end of string)
  const match = description.match(/^[^.]+\./);
  if (match && match[0].length < 120) return match[0];
  // If first sentence is too long, truncate at 120 chars
  if (description.length > 120) return description.slice(0, 117) + "...";
  return description;
}
