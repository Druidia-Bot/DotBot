/**
 * Receptionist — Local File Search
 *
 * Searches the user's filesystem via Everything (Windows only)
 * for files related to the current request.
 *
 * Query generation uses the local LLM (Qwen 2.5 0.5B) for smarter
 * keyword extraction. Falls back to memory-based queries if the
 * local LLM is unavailable or times out.
 */

import { createComponentLogger } from "../logging.js";
import { getPlatformForUser } from "../ws/devices.js";
import { execToolOnAgent } from "./agent-exec.js";
import type { EnhancedPromptRequest } from "../types/agent.js";
import type { ClassifyResult } from "../intake/intake.js";

const log = createComponentLogger("receptionist.search-files");

const LLM_QUERY_TIMEOUT_MS = 3_000;

export interface LocalFileSearchResult {
  results: { query: string; output: string }[];
  skipReason?: string;
}

export async function searchLocalFiles(
  userId: string,
  deviceId: string,
  agentId: string,
  request: EnhancedPromptRequest,
  intakeResult: ClassifyResult,
): Promise<LocalFileSearchResult> {
  const platform = getPlatformForUser(userId);
  if (platform !== "windows") {
    return { results: [], skipReason: `Client platform is ${platform || "unknown"} (Everything search is Windows-only).` };
  }

  const queries = await generateFileSearchQueries(deviceId, agentId, request, intakeResult);
  if (queries.length === 0) {
    return { results: [], skipReason: "No file search queries could be generated from the request." };
  }

  const results: { query: string; output: string }[] = [];
  for (const query of queries) {
    try {
      const output = await execToolOnAgent(deviceId, agentId, "search.files",
        { query, max_results: 20, sort: "date-modified" }, 15_000);
      if (!output || output.startsWith("No files found") || output.startsWith("ERROR:")) {
        if (output?.includes("not installed")) {
          return { results: [], skipReason: "Everything search (es.exe) is not installed. It will be auto-installed on next attempt." };
        }
        continue;
      }
      results.push({ query, output });
    } catch (err) {
      log.debug("Local file search failed", { query, error: err });
      break;
    }
  }
  return { results };
}

// ── Local LLM Query Generation ──────────────────────────────────────

async function generateFileSearchQueries(
  deviceId: string,
  agentId: string,
  request: EnhancedPromptRequest,
  intakeResult: ClassifyResult,
): Promise<string[]> {
  const relevantMemories = (intakeResult.relevantMemories as any[]) || [];
  const memoryContext = relevantMemories
    .slice(0, 3)
    .filter((m: any) => m.name && m.confidence >= 0.5)
    .map((m: any) => m.name)
    .join(", ");

  const truncatedPrompt = request.prompt.slice(0, 300);

  const llmPrompt = [
    `User request: ${truncatedPrompt}`,
    memoryContext ? `Related topics: ${memoryContext}` : "",
    "",
    "Generate 1-3 short file search queries (2-4 words each) to find relevant files on the user's Windows PC.",
    "Focus on project names, document types, proper nouns, and domain-specific terms.",
    "Return ONLY the queries, one per line. No numbering, no explanation.",
  ].filter(Boolean).join("\n");

  try {
    const raw = await Promise.race([
      execToolOnAgent(deviceId, agentId, "llm.local_query", {
        prompt: llmPrompt,
        system: "You generate concise filesystem search queries. Reply with 1-3 queries, one per line. Nothing else.",
        max_tokens: 60,
      }, LLM_QUERY_TIMEOUT_MS + 1_000),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("local LLM timeout")), LLM_QUERY_TIMEOUT_MS)
      ),
    ]);

    const queries = raw
      .split("\n")
      .map(line => line.replace(/^\d+[\.\)]\s*/, "").trim())
      .filter(line => line.length >= 3 && line.length <= 80);

    if (queries.length > 0) {
      log.info("Local LLM generated file search queries", { queries });
      return queries.slice(0, 3);
    }
  } catch (err) {
    log.debug("Local LLM query generation failed, using fallback", { error: err });
  }

  // Fallback: use memory names if local LLM unavailable
  return fallbackQueries(intakeResult);
}

// ── Fallback (memory-based) ─────────────────────────────────────────

function fallbackQueries(intakeResult: ClassifyResult): string[] {
  const queries: string[] = [];
  const relevantMemories = (intakeResult.relevantMemories as any[]) || [];
  for (const mem of relevantMemories.slice(0, 3)) {
    if (mem.name && mem.confidence >= 0.5) queries.push(mem.name);
  }
  return queries;
}
