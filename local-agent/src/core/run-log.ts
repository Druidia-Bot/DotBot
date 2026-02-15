/**
 * Run Log Persistence — Saves pipeline execution traces to disk.
 *
 * Writes JSON files to ~/.bot/run-logs/ with auto-pruning of old entries.
 */

import { promises as fs } from "fs";
import path from "path";
import { DOTBOT_DIR } from "../memory/store-core.js";

const RUN_LOGS_DIR = path.join(DOTBOT_DIR, "run-logs");
const RUN_LOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export async function handleRunLog(payload: any): Promise<void> {
  try {
    await fs.mkdir(RUN_LOGS_DIR, { recursive: true });

    // Filename: timestamp_sessionId.json (sortable, unique)
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const sessionId = (payload.sessionId || "unknown").substring(0, 20);
    const filename = `${ts}_${sessionId}.json`;

    await fs.writeFile(
      path.join(RUN_LOGS_DIR, filename),
      JSON.stringify(payload, null, 2),
      "utf-8"
    );

    // Auto-prune: delete files older than 14 days
    const now = Date.now();
    const files = await fs.readdir(RUN_LOGS_DIR);
    for (const f of files) {
      try {
        const stat = await fs.stat(path.join(RUN_LOGS_DIR, f));
        if (now - stat.mtimeMs > RUN_LOG_MAX_AGE_MS) {
          await fs.unlink(path.join(RUN_LOGS_DIR, f));
        }
      } catch { /* skip files that vanish mid-scan */ }
    }
  } catch (error) {
    console.error("[Agent] Failed to save run log:", error);
  }
}
