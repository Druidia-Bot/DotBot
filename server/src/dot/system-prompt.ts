/**
 * Dot — System Prompt Builder
 *
 * Assembles Dot's system prompt from:
 *   - Identity (me.json skeleton + optional backstory)
 *   - Date/time + platform
 *   - Memory model spines (what Dot knows about)
 *   - Research cache (relevant cached research files)
 *   - Assistant's Log (recent journal entries)
 *
 * Also exports buildTailoredSection() which assembles the per-message
 * tailored principles block — prepended to the user message, NOT the system prompt.
 *
 * The template lives in dot-core.md with |* Field *| placeholders.
 */

import { loadPrompt } from "../prompt-template.js";
import { assembleTailoredPrinciples } from "./pre-dot/index.js";
import type { TailorResult } from "./pre-dot/index.js";
import type { EnhancedPromptRequest } from "../types/agent.js";

const MAX_MEMORY_MODELS = 50;

// ============================================
// MAIN BUILDER
// ============================================

export async function buildDotSystemPrompt(
  request: EnhancedPromptRequest,
  modelSpines: { model: any; spine: string }[],
  platform?: "windows" | "linux" | "macos" | "web",
): Promise<string> {
  const identity = buildIdentitySection(request);
  const memoryModels = buildMemoryModelsSection(modelSpines);
  const dateTime = buildDateTimeString();
  const platformLabel = buildPlatformLabel(platform);

  return loadPrompt("dot/dot-core.md", {
    "Identity": identity,
    "DateTime": dateTime,
    "Platform": platformLabel,
    "MemoryModels": memoryModels,
  });
}

// ============================================
// SECTION BUILDERS
// ============================================

function buildIdentitySection(request: EnhancedPromptRequest): string {
  const skeleton = request.agentIdentity || "Name: Dot\nRole: Personal AI Assistant";

  if (request.backstory) {
    return `## My Origin Story\n\n${request.backstory}\n\n---\n\n${skeleton}`;
  }
  return skeleton;
}

function buildMemoryModelsSection(modelSpines: { model: any; spine: string }[]): string {
  if (modelSpines.length === 0) {
    return "(No memory models available)";
  }

  const sorted = [...modelSpines].sort((a, b) =>
    (b.model.lastUpdatedAt || b.model.createdAt || "").localeCompare(a.model.lastUpdatedAt || a.model.createdAt || "")
  );
  const capped = sorted.slice(0, MAX_MEMORY_MODELS);
  let text = capped.map(s => s.spine).join("\n---\n\n");

  if (sorted.length > MAX_MEMORY_MODELS) {
    text += `\n\n*(${sorted.length - MAX_MEMORY_MODELS} older models omitted — use \`memory.search\` to find them)*`;
  }

  return text;
}

function buildDateTimeString(): string {
  return new Date().toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function buildPlatformLabel(platform?: string): string {
  if (platform === "windows") return "Windows";
  if (platform === "macos") return "macOS";
  if (platform === "linux") return "Linux";
  return "Unknown";
}

/**
 * Build a context preamble from conversation references stored on relevant memory models.
 * These are condensed summaries of past discussions — injected into the user message
 * so Dot has topic continuity without needing the full conversation thread.
 */
export function buildModelContextPreamble(
  modelConversations: { slug: string; name: string; conversations: { timestamp: string; summary: string; keyPoints: string[] }[] }[],
): string {
  if (modelConversations.length === 0) return "";

  const sections: string[] = [];
  for (const model of modelConversations) {
    if (model.conversations.length === 0) continue;
    const refs = model.conversations.slice(-10); // last 10 conversation refs per model
    const lines = refs.map(c => {
      const date = c.timestamp.slice(0, 10);
      const points = c.keyPoints.length > 0 ? ` Key points: ${c.keyPoints.join("; ")}` : "";
      return `- **${date}**: ${c.summary}${points}`;
    });
    sections.push(`### Previous Context — ${model.name}\n\n${lines.join("\n")}`);
  }

  return sections.length > 0 ? sections.join("\n\n") : "";
}

export function buildTailoredSection(tailorResult?: TailorResult, consolidatedPrinciples?: string, forceDispatch?: boolean): string {
  let text = consolidatedPrinciples
    || (tailorResult ? assembleTailoredPrinciples(tailorResult) : "");

  // Inject complexity score as a routing signal for dispatch decisions
  if (tailorResult?.complexity !== null && tailorResult?.complexity !== undefined) {
    text = `\n\n**Task Complexity:** ${tailorResult.complexity}/10` + text;
  }

  // Research cache — relevant entries flagged by the tailor
  if (tailorResult && tailorResult.relevantCache.length > 0) {
    const cacheDir = "~/.bot/memory/research-cache";
    const lines = tailorResult.relevantCache.map(f => `- \`${cacheDir}/${f}\``);
    text += [
      "\n\n### Recent Research",
      "",
      "You have cached research that may be relevant to this conversation. Use `filesystem.read_file` to review any of these before answering:",
      "",
      ...lines,
    ].join("\n");
  }

  // Hard directive: complexity above threshold — Dot MUST dispatch
  if (forceDispatch) {
    text += `\n\n---\n**⚠ MANDATORY DISPATCH:** This task scored ${tailorResult?.complexity ?? "high"}/10 complexity. You MUST use \`task.dispatch\` for this request. Present your proposed steps and time estimate, ask for confirmation, then dispatch. Do NOT attempt to handle this yourself.`;
  }

  return text;
}
