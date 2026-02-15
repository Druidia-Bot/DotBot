/**
 * CLI Interface — Interactive readline prompt for local terminal usage.
 *
 * Provides status, memory inspection, and prompt submission commands.
 */

import * as memory from "../memory/index.js";
import { send, isConnected } from "./ws-client.js";
import { DEVICE_NAME, deviceCredentials } from "./config.js";
import type { WSMessage } from "../types.js";
import { nanoid } from "nanoid";

let rl: import("readline").Interface;

export async function initCli(): Promise<import("readline").Interface> {
  const readline = await import("readline");
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return rl;
}

export function getCli(): import("readline").Interface {
  return rl;
}

// ============================================
// MEMORY STATUS
// ============================================

async function showMemoryStatus(): Promise<void> {
  try {
    const memIndex = await memory.getMemoryIndex();
    const skills = await memory.getAllSkills();

    console.log("\n[Memory Status]");
    console.log(`  Mental Models: ${memIndex.models.length}`);
    console.log(`  Schemas: ${memIndex.schemas.length}`);
    console.log(`  Skills: ${skills.length}`);

    if (memIndex.models.length > 0) {
      console.log("\n  Recent Models:");
      const recent = memIndex.models
        .sort((a: memory.MentalModelIndexEntry, b: memory.MentalModelIndexEntry) => new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime())
        .slice(0, 5);
      for (const m of recent) {
        console.log(`    - ${m.name} (${m.category}) - ${m.beliefCount} beliefs, ${m.openLoopCount} open loops`);
      }
    }

    if (skills.length > 0) {
      console.log("\n  Skills:");
      for (const s of skills.slice(0, 5)) {
        console.log(`    - /${s.name} — ${s.description.substring(0, 60)}${s.description.length > 60 ? "..." : ""}`);
      }
    }
    console.log("");
  } catch (error) {
    console.error("[Agent] Failed to get memory status:", error);
  }
}

// ============================================
// PROMPT LOOP
// ============================================

export function promptUser(): void {
  rl.question("\n> ", (input) => {
    const trimmed = input.trim();

    if (trimmed === "quit" || trimmed === "exit") {
      console.log("[Agent] Goodbye!");
      process.exit(0);
    }

    if (trimmed === "status") {
      console.log(`[Agent] Connection: ${isConnected() ? "Connected" : "Disconnected"}`);
      console.log(`[Agent] Device: ${DEVICE_NAME} (${deviceCredentials?.deviceId ?? "unregistered"})`);
      promptUser();
      return;
    }

    if (trimmed === "memory") {
      showMemoryStatus();
      promptUser();
      return;
    }

    if (trimmed) {
      // Run local LLM pre-classification, then send prompt to server
      import("../llm/prompt-classifier.js").then(({ classifyPromptLocally }) =>
        classifyPromptLocally(trimmed).then(hints => {
          send({
            type: "prompt",
            id: nanoid(),
            timestamp: Date.now(),
            payload: { prompt: trimmed, hints }
          });
        })
      ).catch(() => {
        // Fallback: send without hints if classifier import fails
        send({
          type: "prompt",
          id: nanoid(),
          timestamp: Date.now(),
          payload: { prompt: trimmed }
        });
      });
    }

    promptUser();
  });
}
