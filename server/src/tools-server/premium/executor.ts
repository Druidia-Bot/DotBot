/**
 * Premium Tool Executor
 *
 * Thin router: resolves the provider for a tool ID, checks credits,
 * delegates execution, deducts on success, formats the result.
 * Provider-agnostic — never imports a specific provider directly.
 */

import { deductCredits, getBalance } from "../../credits/service.js";
import { createComponentLogger } from "#logging.js";
import { PROVIDERS } from "./providers/index.js";
import { listApis } from "./list.js";
import type { PremiumApiEntry, PremiumToolResult } from "./types.js";

const log = createComponentLogger("premium");

const MAX_OUTPUT_LENGTH = 10_000;

/**
 * Execute a premium tool call.
 * Routes meta-tools internally, everything else to the matching provider.
 */
export async function executePremiumTool(
  userId: string,
  toolId: string,
  args: Record<string, any>,
): Promise<PremiumToolResult> {
  // ── Meta tools ──────────────────────────────────────────────
  if (toolId === "premium.list_apis") {
    return listApis(userId);
  }

  if (toolId === "premium.check_credits") {
    const balance = getBalance(userId);
    return {
      success: true,
      output: `You have ${balance} credits remaining. New users start with 50 credits. Use premium.list_apis to see available APIs and their costs.`,
      creditsUsed: 0,
      creditsRemaining: balance,
    };
  }

  if (toolId !== "premium.execute") {
    return fail(`Unknown premium tool: ${toolId}`, userId);
  }

  // ── Resolve API + provider ──────────────────────────────────
  const apiId = args.api;
  if (!apiId) {
    return fail("Missing required field: api. Use premium.list_apis to see available APIs.", userId);
  }

  const resolved = resolveProvider(apiId);
  if (!resolved) {
    return fail(`Unknown API: ${apiId}. Use premium.list_apis to see available APIs.`, userId);
  }
  const { provider, apiEntry } = resolved;

  // ── Credit check ────────────────────────────────────────────
  const balance = getBalance(userId);
  if (balance < apiEntry.creditCost) {
    return {
      success: false,
      output: "",
      error: `Insufficient credits. This API costs ${apiEntry.creditCost} credits, but you only have ${balance}. You'll need to replenish your credits to use premium tools.`,
      creditsUsed: 0,
      creditsRemaining: balance,
    };
  }

  // ── Validate required params ────────────────────────────────
  for (const param of apiEntry.requiredParams) {
    if (!args[param]) {
      return { success: false, output: "", error: `Missing required parameter: ${param}`, creditsUsed: 0, creditsRemaining: balance };
    }
  }

  // ── Execute via provider ────────────────────────────────────
  try {
    const response = await provider.execute(apiEntry, args);

    // Deduct credits on success
    const newBalance = deductCredits(
      userId,
      apiEntry.creditCost,
      `premium.${apiId}`,
      `${apiEntry.name} call`,
      { query: args.query || args.url || args.asin || "N/A" },
    );

    const output = formatResponse(response);

    log.info("Premium tool executed", { userId, apiId, provider: provider.name, creditCost: apiEntry.creditCost, newBalance });

    return {
      success: true,
      output: `[${apiEntry.name}] (${apiEntry.creditCost} credits used, ${newBalance} remaining)\n\n${output}`,
      creditsUsed: apiEntry.creditCost,
      creditsRemaining: newBalance,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn("Premium tool failed", { userId, apiId, provider: provider.name, error: msg });
    return { success: false, output: "", error: `${apiEntry.name} failed: ${msg}`, creditsUsed: 0, creditsRemaining: balance };
  }
}

// ============================================
// HELPERS
// ============================================

function resolveProvider(apiId: string): { provider: (typeof PROVIDERS)[number]; apiEntry: PremiumApiEntry } | null {
  for (const provider of PROVIDERS) {
    if (!provider.handles(apiId)) continue;
    const apiEntry = provider.getCatalog().find(a => a.id === apiId);
    if (apiEntry) return { provider, apiEntry };
  }
  return null;
}

function formatResponse(raw: string): string {
  try {
    const json = JSON.parse(raw);
    const pretty = JSON.stringify(json, null, 2);
    return pretty.length > MAX_OUTPUT_LENGTH
      ? pretty.substring(0, MAX_OUTPUT_LENGTH) + "\n... (truncated, response was too large)"
      : pretty;
  } catch {
    return raw.length > MAX_OUTPUT_LENGTH
      ? raw.substring(0, MAX_OUTPUT_LENGTH) + "\n... (truncated)"
      : raw;
  }
}

function fail(error: string, userId: string): PremiumToolResult {
  return { success: false, output: "", error, creditsUsed: 0, creditsRemaining: getBalance(userId) };
}
