/**
 * Run Log Persistence — Saves pipeline execution traces to disk.
 *
 * One file per day: ~/.bot/run-logs/YYYY-MM-DD.log
 * Each entry is a JSON line (JSONL) appended to the day's file.
 * Files older than 72 hours are auto-pruned.
 */

import { promises as fs } from "fs";
import path from "path";
import { DOTBOT_DIR } from "../memory/store-core.js";

const RUN_LOGS_DIR = path.join(DOTBOT_DIR, "run-logs");
const RUN_LOG_MAX_AGE_MS = 72 * 60 * 60 * 1000; // 72 hours

export async function handleRunLog(payload: any): Promise<void> {
  try {
    await fs.mkdir(RUN_LOGS_DIR, { recursive: true });

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const filename = `${dateStr}.log`;
    const entry = JSON.stringify({ ...payload, _ts: now.toISOString() }) + "\n";

    await fs.appendFile(path.join(RUN_LOGS_DIR, filename), entry, "utf-8");

    // Auto-prune: delete .log files older than 72 hours
    const nowMs = Date.now();
    const files = await fs.readdir(RUN_LOGS_DIR);
    for (const f of files) {
      if (!f.endsWith(".log")) continue;
      try {
        const stat = await fs.stat(path.join(RUN_LOGS_DIR, f));
        if (nowMs - stat.mtimeMs > RUN_LOG_MAX_AGE_MS) {
          await fs.unlink(path.join(RUN_LOGS_DIR, f));
        }
      } catch { /* skip files that vanish mid-scan */ }
    }
  } catch (error) {
    console.error("[Agent] Failed to save run log:", error);
  }
}
