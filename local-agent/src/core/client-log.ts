/**
 * Client Log Writer — Generic log persistence to ~/.bot/{subfolder}/
 *
 * Single entry point for all server → client log writes. The server
 * sends a `run_log` WS message; the message router calls writeClientLog().
 *
 * Payload fields:
 *   - subfolder:     directory under ~/.bot/ (e.g. "run-logs", "principals-log")
 *   - filename:      target file name
 *   - content:       text to write
 *   - mode:          "write" (overwrite/create) or "append" (default: "write")
 *   - pruneAfterMs:  if set, delete files in subfolder older than this (ms). null = keep forever.
 */

import { promises as fs } from "fs";
import path from "path";
import { DOTBOT_DIR } from "../memory/store-core.js";

export async function writeClientLog(payload: {
  subfolder: string;
  filename: string;
  content: string;
  mode?: "write" | "append";
  pruneAfterMs?: number | null;
}): Promise<void> {
  const { subfolder, filename, content, mode = "write", pruneAfterMs } = payload;

  // Sanitize — prevent path traversal
  const safeSubfolder = subfolder.replace(/\.\./g, "").replace(/[<>:"|?*]/g, "");
  const safeFilename = path.basename(filename);

  const dir = path.join(DOTBOT_DIR, safeSubfolder);
  try {
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, safeFilename);
    if (mode === "append") {
      await fs.appendFile(filePath, content, "utf-8");
    } else {
      await fs.writeFile(filePath, content, "utf-8");
    }

    // Prune old files if requested
    if (pruneAfterMs != null && pruneAfterMs > 0) {
      const nowMs = Date.now();
      const files = await fs.readdir(dir);
      for (const f of files) {
        try {
          const stat = await fs.stat(path.join(dir, f));
          if (nowMs - stat.mtimeMs > pruneAfterMs) {
            await fs.unlink(path.join(dir, f));
          }
        } catch { /* skip files that vanish mid-scan */ }
      }
    }
  } catch (error) {
    console.error(`[Agent] Failed to write log to ${safeSubfolder}/${safeFilename}:`, error);
  }
}
