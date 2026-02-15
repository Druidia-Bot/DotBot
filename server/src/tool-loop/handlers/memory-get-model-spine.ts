/**
 * Tool Handler — memory.get_model_spine
 *
 * Returns a structured summary of a memory model: rendered beliefs,
 * open loops, constraints, questions, and a data shape line showing
 * counts for every key. Lighter than get_model_detail.
 *
 * The `formatModelSpine` function is exported so other server code
 * (e.g. memory-fetch.ts) can reuse the same formatting without
 * duplicating logic.
 */

import { createComponentLogger } from "#logging.js";
import { sendMemoryRequest } from "#ws/device-bridge.js";
import type { ToolContext } from "../types.js";

const log = createComponentLogger("tool-loop.memory.get_model_spine");

export async function handleMemoryGetModelSpine(ctx: ToolContext, args: Record<string, any>): Promise<string> {
  const slug = args.slug || "";
  const model = await sendMemoryRequest(ctx.deviceId, {
    action: "get_model_detail",
    modelSlug: slug,
  } as any);

  log.info("get_model_spine", { slug, found: !!model });

  if (!model) return `Model "${slug}" not found.`;

  return formatModelSpine(model);
}

// ============================================
// SPINE FORMATTER (reusable)
// ============================================

/**
 * Format a raw memory model into a structured markdown spine.
 * Shows: header, beliefs, open loops, constraints, questions,
 * resolved issues, and a data shape line with counts for every key.
 */
export function formatModelSpine(model: any, confidence?: number): string {
  const lines: string[] = [];
  const conf = confidence != null ? ` — confidence: ${confidence}` : "";
  lines.push(`### ${model.name || model.slug} (${model.category || "unknown"})${conf}`);
  if (model.description) lines.push(`> ${model.description}`);
  lines.push("");

  // Beliefs — only confident, recent ones
  const allBeliefs: any[] = model.beliefs || [];
  const currentBeliefs = allBeliefs
    .filter((b: any) => (b.confidence ?? 0) >= 0.5)
    .sort((a: any, b: any) =>
      (b.lastConfirmedAt || b.formedAt || "").localeCompare(a.lastConfirmedAt || a.formedAt || "")
    );
  const MAX_BELIEFS = 15;
  const shownBeliefs = currentBeliefs.slice(0, MAX_BELIEFS);
  if (shownBeliefs.length > 0) {
    const omitted = currentBeliefs.length - shownBeliefs.length;
    lines.push(`**Current Beliefs** (${shownBeliefs.length} of ${allBeliefs.length}, confidence ≥ 0.5):`);
    for (const b of shownBeliefs) {
      const val = typeof b.value === "object" ? JSON.stringify(b.value) : String(b.value);
      const valTrunc = val.length > 200 ? val.slice(0, 200) + "…" : val;
      const evidenceSummary = (b.evidence || [])
        .map((e: any) => e.content || "")
        .filter(Boolean)
        .slice(0, 2)
        .join("; ");
      const evidenceStr = evidenceSummary ? ` — Evidence: ${evidenceSummary}` : "";
      lines.push(`- **${b.attribute}**: ${valTrunc} (confidence: ${b.confidence ?? "??"})${evidenceStr}`);
    }
    if (omitted > 0) lines.push(`- *(${omitted} more beliefs omitted — use \`get_model_field\` to see all)*`);
    lines.push("");
  }

  // Constraints
  const constraints: any[] = model.constraints || [];
  if (constraints.length > 0) {
    lines.push("**Constraints:**");
    for (const c of constraints) {
      lines.push(`- ${c.description} (${c.type || "unknown"}, ${c.flexibility || "unknown"})`);
    }
    lines.push("");
  }

  // Open Loops — only active/blocked (not resolved)
  const allLoops: any[] = model.openLoops || [];
  const activeLoops = allLoops.filter((ol: any) => ol.status !== "resolved");
  if (activeLoops.length > 0) {
    lines.push("**Open Loops:**");
    for (const ol of activeLoops) {
      const criteria = ol.resolutionCriteria ? ` → ${ol.resolutionCriteria}` : "";
      lines.push(`- [${ol.importance || "?"}, ${ol.status || "?"}] ${ol.description}${criteria}`);
    }
    lines.push("");
  }

  // Resolved Issues — only last 5 recent
  const allResolved: any[] = model.resolvedIssues || [];
  const recentResolved = allResolved.slice(-5);
  if (recentResolved.length > 0) {
    const omitted = allResolved.length - recentResolved.length;
    lines.push(`**Recently Resolved Issues** (last ${recentResolved.length}${omitted > 0 ? ` of ${allResolved.length}` : ""}):`);
    for (const r of recentResolved) {
      lines.push(`- ${r.description || r.summary || JSON.stringify(r)}`);
    }
    lines.push("");
  }

  // Questions
  const questions: any[] = model.questions || [];
  if (questions.length > 0) {
    lines.push("**Current Questions:**");
    for (const q of questions) {
      lines.push(`- ${typeof q === "string" ? q : q.question || q.description || JSON.stringify(q)}`);
    }
    lines.push("");
  }

  // Data shape — show ALL keys with counts so the LLM knows what's available
  const relationships: any[] = model.relationships || [];
  const conversations: any[] = model.conversations || [];
  const resolvedIssues: any[] = model.resolvedIssues || [];

  const lastConvo = conversations.length > 0 ? conversations[conversations.length - 1] : null;
  const lastDate = lastConvo?.timestamp ? lastConvo.timestamp.slice(0, 10) : "none";

  lines.push(`**Data Shape:** beliefs: ${allBeliefs.length} · openLoops: ${allLoops.length} · constraints: ${constraints.length} · questions: ${questions.length} · relationships: ${relationships.length} · resolvedIssues: ${resolvedIssues.length} · conversations: ${conversations.length} (last: ${lastDate})`);
  if (model.createdAt || model.lastUpdatedAt) {
    const meta: string[] = [];
    if (model.createdAt) meta.push(`Created: ${model.createdAt.slice(0, 10)}`);
    if (model.lastUpdatedAt) meta.push(`Updated: ${model.lastUpdatedAt.slice(0, 10)}`);
    lines.push(meta.join(" · "));
  }
  lines.push("");
  lines.push(`> Use \`memory.get_model_field\` with slug \`${model.slug}\` and field name (e.g. \`beliefs\`, \`conversations\`, \`openLoops\`) to retrieve specific sections. Use \`memory.get_model_detail\` for the full model.`);
  lines.push("");

  return lines.join("\n");
}
