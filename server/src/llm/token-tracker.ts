/**
 * Token Tracker — Per-Device LLM Token Usage Recording
 *
 * Records all LLM token usage to the server's SQLite token_usage table.
 * No hard limits — just recording for usage pattern analysis.
 *
 * Wired into ResilientLLMClient — every LLM call is automatically tracked.
 */

import { createComponentLogger } from "#logging.js";
import { getDatabase } from "../db/index.js";

const log = createComponentLogger("token-tracker");

// ============================================
// TYPES
// ============================================

export interface TokenUsageEntry {
  deviceId: string;
  model: string;
  role: string;
  inputTokens: number;
  outputTokens: number;
  agentId?: string;
}

// ============================================
// TRACKING
// ============================================

/**
 * Record a single LLM call's token usage.
 * This is fire-and-forget — failures are logged, never surfaced.
 */
export function recordTokenUsage(entry: TokenUsageEntry): void {
  try {
    const db = getDatabase();
    if (!db) return;

    const stmt = db.prepare(`
      INSERT INTO token_usage (device_id, timestamp, model, role, input_tokens, output_tokens, agent_id)
      VALUES (?, datetime('now'), ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entry.deviceId,
      entry.model,
      entry.role,
      entry.inputTokens,
      entry.outputTokens,
      entry.agentId || null
    );
  } catch (error) {
    // Non-fatal — don't crash the pipeline for token tracking
    log.warn("Failed to record token usage", { error });
  }
}

/**
 * Get total token usage for a device in a time range.
 */
export function getDeviceUsage(
  deviceId: string,
  sinceHours: number = 24
): { model: string; role: string; inputTokens: number; outputTokens: number; callCount: number }[] {
  try {
    const db = getDatabase();
    if (!db) return [];

    const rows = db.prepare(`
      SELECT model, role,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        COUNT(*) as call_count
      FROM token_usage
      WHERE device_id = ? AND timestamp >= datetime('now', ?)
      GROUP BY model, role
      ORDER BY input_tokens DESC
    `).all(deviceId, `-${sinceHours} hours`) as any[];

    return rows.map(r => ({
      model: r.model,
      role: r.role,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      callCount: r.call_count,
    }));
  } catch (error) {
    log.warn("Failed to get device usage", { error });
    return [];
  }
}

/**
 * Get total tokens used by a specific agent (for analysis).
 */
export function getAgentUsage(agentId: string): { inputTokens: number; outputTokens: number; callCount: number } {
  try {
    const db = getDatabase();
    if (!db) return { inputTokens: 0, outputTokens: 0, callCount: 0 };

    const row = db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COUNT(*) as call_count
      FROM token_usage
      WHERE agent_id = ?
    `).get(agentId) as any;

    return {
      inputTokens: row?.input_tokens || 0,
      outputTokens: row?.output_tokens || 0,
      callCount: row?.call_count || 0,
    };
  } catch (error) {
    log.warn("Failed to get agent usage", { error });
    return { inputTokens: 0, outputTokens: 0, callCount: 0 };
  }
}
