/**
 * Receptionist — Output Builders
 *
 * Builds intake_knowledge.md (full dossier — template-based).
 */

import { loadPrompt } from "../../prompt-template.js";
import type { EnhancedPromptRequest } from "../../types/agent.js";
import type { ClassifyResult } from "../intake/intake.js";
import type { KnowledgebaseInput } from "./types.js";

// ============================================
// INTAKE KNOWLEDGE (full dossier — template-based)
// ============================================

/**
 * Build the full intake knowledgebase dossier from a .md template.
 * Uses the same |* Field *| placeholder system as all other prompts.
 */
export async function buildIntakeKnowledge(input: KnowledgebaseInput): Promise<string> {
  const {
    agentId, intakeResult,
    relevantModelSummaries, knowledgeResults,
    resurfacedModels, newModelsCreated,
  } = input;

  // ── Model mutation sections ──

  const resurfacedSection = resurfacedModels.length > 0
    ? ["### Resurfaced from Archive", ...resurfacedModels.map(s => `- \`${s}\``)].join("\n")
    : "";

  const newModelsSection = newModelsCreated.length > 0
    ? ["### Newly Created Models", ...newModelsCreated.map(s => `- \`${s}\``)].join("\n")
    : "";

  // ── Related models summary ──

  const relatedModelsSummary = buildRelatedModelsSummary(intakeResult, input.request);

  // ── Local file results (Windows only) ──

  const localFileResults = input.localFileResults || [];
  let localFileResultsText: string;

  if (localFileResults.length > 0) {
    const sections = localFileResults.map(fr =>
      `### Search: "${fr.query}"\n\`\`\`\n${fr.output}\n\`\`\``
    );
    localFileResultsText = [
      "The receptionist searched this machine's filesystem for files related to your request. Results below are **filenames, paths, and sizes only**.",
      "",
      ...sections,
    ].join("\n");
  } else {
    localFileResultsText = input.localFileSearchSkipReason || "No local file search was performed.";
  }

  // ── Knowledge results ──

  const { knowledgeSearchCount = 0 } = input;
  let knowledgeResultsText: string;
  if (knowledgeResults.length > 0) {
    knowledgeResultsText = knowledgeResults.map(kr =>
      `### Query: "${kr.query}"\n${kr.content}`
    ).join("\n\n");
  } else if (knowledgeSearchCount > 0) {
    knowledgeResultsText = `The receptionist searched the knowledge base (${knowledgeSearchCount} query/queries) but found no relevant results. If you need background information, use \`knowledge.search\` with different terms.`;
  } else {
    knowledgeResultsText = "The receptionist did not perform any knowledge base searches for this request. If you need background information, use `knowledge.search` to find relevant documents.";
  }

  // ── Polymarket prediction markets ──

  const polymarketResults = input.polymarketResults || [];
  let polymarketResultsText: string;

  if (polymarketResults.length > 0) {
    const sections: string[] = [];
    for (const { query, markets } of polymarketResults) {
      sections.push(`### Search: "${query}"`, "");
      for (const m of markets) {
        const question = m.question || "(unknown)";
        const prices = parseOutcomePrices(m.outcomePrices);
        const volume = m.volume || "N/A";
        const liquidity = m.liquidity || "N/A";
        const endDate = m.endDate ? new Date(m.endDate).toLocaleDateString() : "N/A";

        sections.push(
          `**${question}**`,
          `- Probability: ${prices}`,
          `- Volume: ${volume} | Liquidity: ${liquidity} | Ends: ${endDate}`,
          "",
        );
      }
    }
    polymarketResultsText = sections.join("\n");
  } else {
    polymarketResultsText = "No relevant prediction markets found. Use `market.polymarket_search` to search for specific topics if needed.";
  }

  // ── Web search results ──

  const webSearchResults = input.webSearchResults || [];
  let webSearchResultsText: string;

  if (webSearchResults.length > 0) {
    const sections: string[] = [];
    for (const { query, results: pages } of webSearchResults) {
      sections.push(`### Search: "${query}"`, "");
      if (pages.length === 0) { sections.push("No results found.", ""); continue; }
      for (const page of pages) {
        sections.push(`#### ${page.title}`, `**URL:** ${page.url}`, "", page.description || "(No description available)", "");
      }
    }
    webSearchResultsText = sections.join("\n");
  } else {
    webSearchResultsText = "No web search was performed for this request. Use `search.brave` to search the web if needed.";
  }

  // ── Assemble fields for template ──

  const fields: Record<string, string> = {
    "Agent ID": agentId,
    "Timestamp": new Date().toISOString(),
    "Relevant Model Summaries": relevantModelSummaries,
    "Resurfaced Models Section": resurfacedSection,
    "New Models Section": newModelsSection,
    "Related Models Summary": relatedModelsSummary,
    "Local File Results": localFileResultsText,
    "Knowledge Results": knowledgeResultsText,
    "Web Search Results": webSearchResultsText,
    "Polymarket Results": polymarketResultsText,
  };

  return loadPrompt("pipeline/receptionist/intake-knowledge.md", fields);
}

// ============================================
// POLYMARKET HELPERS
// ============================================

/**
 * Parse Polymarket outcomePrices into a readable string.
 * Input is typically a JSON string like '["0.65","0.35"]' representing Yes/No probabilities.
 */
function parseOutcomePrices(raw: unknown): string {
  if (!raw) return "N/A";

  try {
    const prices = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(prices) || prices.length < 2) return String(raw);

    const yesPrice = (parseFloat(prices[0]) * 100).toFixed(1);
    const noPrice = (parseFloat(prices[1]) * 100).toFixed(1);
    return `Yes ${yesPrice}% / No ${noPrice}%`;
  } catch {
    return String(raw);
  }
}

// ============================================
// RELATED MODELS SUMMARY
// ============================================

/**
 * Build a summary of possibly-related memory models from the intake result.
 * These are models that MIGHT pertain but we aren't certain.
 * Includes slug, description, and tool guidance so the agent can decide whether to explore.
 */
function buildRelatedModelsSummary(intakeResult: ClassifyResult, request: EnhancedPromptRequest): string {
  const rawRelated = (intakeResult.relatedMemories as any[]) || [];
  // Defensive: LLM sometimes returns objects ({name, confidence}) instead of plain strings
  const relatedMemories: string[] = rawRelated
    .map(m => typeof m === "string" ? m : m?.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);

  if (relatedMemories.length === 0) {
    return "(No additional related models identified)";
  }

  // Build a lookup from name/slug → description using the memory index
  const indexBySlug = new Map<string, { description: string; category: string }>();
  for (const m of (request.memoryIndex || []) as any[]) {
    indexBySlug.set(m.slug, { description: m.description || "", category: m.category || "unknown" });
  }

  const lines: string[] = [
    `**${relatedMemories.length} topic(s) that may be related:**`,
    "",
    ...relatedMemories.map(name => {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const info = indexBySlug.get(slug);
      const desc = info?.description ? ` — ${info.description}` : "";
      const cat = info?.category ? ` (${info.category})` : "";
      return `- **${name}**${cat} [\`${slug}\`]${desc}`;
    }),
    "",
    `> Use \`memory.get_model_spine\` with the slug above to see the data shape and decide if a model is worth exploring further.`,
  ];

  return lines.join("\n");
}
