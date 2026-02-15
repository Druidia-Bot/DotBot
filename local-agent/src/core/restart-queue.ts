/**
 * Restart Queue — Re-submit prompts saved before a system.restart.
 *
 * When the agent restarts (exit code 42), any in-flight prompts are saved
 * to ~/.bot/restart-queue.json. On next startup, they're re-submitted.
 */

import { promises as fs } from "fs";
import path from "path";
import { DOTBOT_DIR } from "../memory/store-core.js";
import type { WSMessage } from "../types.js";

const RESTART_QUEUE_PATH = path.join(DOTBOT_DIR, "restart-queue.json");

export { RESTART_QUEUE_PATH };

export async function resubmitRestartQueue(
  sendFn: (msg: WSMessage) => void,
  nanoid: () => string,
): Promise<void> {
  try {
    const raw = await fs.readFile(RESTART_QUEUE_PATH, "utf-8");
    const queue = JSON.parse(raw);
    const prompts: string[] = queue.prompts || [];
    if (prompts.length === 0) return;

    // Delete the file first so we don't re-submit on every reconnect
    await fs.unlink(RESTART_QUEUE_PATH).catch(() => {});

    console.log(`[Agent] Re-submitting ${prompts.length} prompt(s) from pre-restart queue`);
    for (const prompt of prompts) {
      sendFn({
        type: "prompt",
        id: nanoid(),
        timestamp: Date.now(),
        payload: {
          prompt: `[Resumed after restart] ${prompt}`,
          source: "restart_queue",
        },
      });
    }
  } catch {
    // No restart queue file — normal startup, nothing to do
  }
}
