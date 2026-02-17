/**
 * Assembler — Fast Fallback
 *
 * Assembles tailored principles into a text block prepended to the user message
 * without an LLM call. Used when the consolidator is skipped (≤2 principles)
 * or as a fallback when the consolidator LLM call fails.
 */

import type { TailorResult } from "./types.js";

/**
 * Assemble the tailored principles into a single text block
 * for prepending to the user message.
 *
 * - If tailoring succeeded: uses tailored directives for applicable principles,
 *   plus raw bodies for always-on principles that weren't tailored.
 * - If tailoring failed (empty tailored map): falls back to all raw principle bodies.
 */
export function assembleTailoredPrinciples(result: TailorResult): string {
  const { tailored, principles } = result;
  const hasTailored = Object.keys(tailored).length > 0;

  if (!hasTailored) {
    // Fallback: include all raw principle bodies
    return principles.map(p => p.body).join("\n\n---\n\n");
  }

  const sections: string[] = [];

  for (const p of principles) {
    const directive = tailored[p.id];

    if (directive !== null && directive !== undefined) {
      // Tailored directive — use it
      sections.push(`## ${p.id.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}\n\n${directive}`);
    } else if (p.always) {
      // Always-on but not tailored — include raw body
      sections.push(p.body);
    }
    // else: not applicable and not always-on — skip
  }

  if (sections.length === 0) {
    return "";
  }

  return "\n\n---\n\n## Situation-Specific Guidance\n\n" + sections.join("\n\n---\n\n");
}
