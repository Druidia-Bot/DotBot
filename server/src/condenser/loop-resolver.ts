/**
 * Loop Resolver
 *
 * Attempts to close open loops (unresolved items) using available tools.
 * Called during the sleep cycle when a loop has a toolHint suggesting
 * automated resolution is possible (web_search, email_lookup, etc.).
 *
 * If tool execution is available, uses the agentic tool loop so the LLM
 * can actually perform searches. Falls back to LLM-only reasoning otherwise.
 *
 * Follows the standard prompt pattern:
 * - loop-resolver.md             — prompt template with |* Field *| placeholders
 * - loop-resolver.schema.json    — JSON schema sent to LLM for structured output
 */

import { createLLMClient, selectModel } from "../llm/providers.js";
import { loadPrompt, loadSchema } from "../prompt-template.js";
import { createComponentLogger } from "../logging.js";
import { runToolLoop, buildProxyHandlers } from "../tool-loop/index.js";
import { manifestToNativeTools } from "../agents/tools.js";
import type {
  CondenserOptions,
  LoopResolverRequest,
  LoopResolverToolOptions,
  LoopResolverResult,
} from "./types.js";

const log = createComponentLogger("condenser.resolver");

// ── Formatters ──────────────────────────────────────────────────────

function formatLoop(request: LoopResolverRequest): string {
  return [
    `**Model:** ${request.modelName} (${request.modelSlug})`,
    `**Loop:** ${request.loop.description}`,
    `**Importance:** ${request.loop.importance}`,
    `**Resolution Criteria:** ${request.loop.resolutionCriteria}`,
    `**Tool Hint:** ${request.loop.toolHint || "none"}`,
  ].join("\n");
}

function formatContext(request: LoopResolverRequest): string {
  if (!request.contextBeliefs.length) return "No beliefs yet.";
  return request.contextBeliefs
    .map(b => `- ${b.attribute}: ${JSON.stringify(b.value)}`)
    .join("\n");
}

// ── Parse ───────────────────────────────────────────────────────────

function parseResolverResponse(content: string): LoopResolverResult {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { resolved: false, blockedReason: "Resolver returned no JSON", notifyUser: false, newStatus: "blocked" };
    }
    return JSON.parse(jsonMatch[0]);
  } catch {
    return { resolved: false, blockedReason: "Failed to parse resolver response", notifyUser: false, newStatus: "blocked" };
  }
}

// ── Entry Point ─────────────────────────────────────────────────────

export async function runLoopResolver(
  request: LoopResolverRequest,
  options: CondenserOptions,
  toolOptions?: LoopResolverToolOptions,
): Promise<LoopResolverResult> {
  const llm = createLLMClient({ apiKey: options.apiKey, provider: options.provider || "deepseek" });
  const modelConfig = selectModel({ personaModelTier: "smart" });

  const [prompt, resolverSchema] = await Promise.all([
    loadPrompt("condenser/loop-resolver.md", {
      Identity: request.identity || "Name: Dot\nRole: AI Assistant",
      Loop: formatLoop(request),
      Context: formatContext(request),
    }),
    loadSchema("condenser/loop-resolver.schema.json"),
  ]);

  log.info("Running loop resolver", {
    modelSlug: request.modelSlug,
    loopId: request.loop.id,
    toolHint: request.loop.toolHint,
  });

  // If tool execution is available, use the tool loop so the LLM can
  // actually perform searches and HTTP requests to resolve the loop.
  if (toolOptions) {
    const researchTools = toolOptions.toolManifest.filter(
      t => ["search", "http"].includes(t.category),
    );

    if (researchTools.length > 0) {
      const handlers = buildProxyHandlers(researchTools);
      const nativeTools = manifestToNativeTools(researchTools);
      const result = await runToolLoop({
        client: llm,
        model: modelConfig.model,
        maxTokens: modelConfig.maxTokens,
        temperature: 0.3,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: "Resolve this open loop using the available tools. Return JSON when done." },
        ],
        tools: nativeTools,
        handlers,
        maxIterations: 3,
        context: { deviceId: "", state: {} },
        personaId: "loop-resolver",
      });

      return parseResolverResponse(result.finalContent);
    }
  }

  // Fallback: LLM-only reasoning (no tools available)
  const response = await llm.chat(
    [{ role: "user", content: prompt }],
    {
      model: modelConfig.model,
      maxTokens: modelConfig.maxTokens,
      temperature: 0.3,
      responseFormat: "json_object",
      responseSchema: { name: "loop_resolver", schema: resolverSchema },
    },
  );

  return parseResolverResponse(response.content);
}
