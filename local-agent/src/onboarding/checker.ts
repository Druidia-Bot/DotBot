/**
 * Onboarding Checker — Periodic task that nags about incomplete steps
 * 
 * Reads onboarding.json and sends gentle reminders for pending steps.
 * Nags at most once per day, rotating through incomplete items.
 */

import { promises as fs } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  onboardingExists,
  readOnboarding,
  recordNag,
  getIncompleteSteps,
  isOnboardingComplete,
} from "./store.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Friendly nag messages per step
const NAG_MESSAGES: Record<string, string> = {
  name_preference: "We never settled on what you want to call me. Want to pick a name?",
  phone_type: "Quick one — iPhone or Android? Helps me send you the right links.",
  personality_transfer: "If you use ChatGPT or Claude, I can import what they know about you. Takes 30 seconds.",
  discord_setup: "We still haven't set up Discord. It's how you can talk to me from your phone — takes about 2 minutes.",
  brave_search: "I still can't search the web for you. Want to set up Brave Search? It's free and takes about 60 seconds.",
  codegen_tools: "If you have a Claude or OpenAI subscription, I can set up extra coding capabilities.",
  systems_check: "I haven't run a systems check yet. Want me to make sure everything's working?",
  git_backup: "Your config and memories aren't backed up yet. Want me to set up version control?",
};

let notifyCallback: ((message: string) => void) | null = null;
let discordCallback: ((message: string) => void) | null = null;

export function setOnboardingNotifyCallback(cb: (message: string) => void): void {
  notifyCallback = cb;
}

export function setOnboardingDiscordCallback(cb: (message: string) => void): void {
  discordCallback = cb;
}

/**
 * Check onboarding status and nag if needed.
 * Called by the periodic task manager.
 */
let skillDeletedFlag = false;

export async function checkOnboarding(): Promise<void> {
  try {
    if (!(await onboardingExists())) return;

    const state = await readOnboarding();

    // If complete, auto-delete onboarding skill directory (one-shot)
    if (isOnboardingComplete(state)) {
      if (!skillDeletedFlag) {
        skillDeletedFlag = true;
        try {
          const skillDir = join(homedir(), ".bot", "skills", "onboarding");
          await fs.rm(skillDir, { recursive: true, force: true });
          console.log("[Onboarding] Onboarding complete — skill directory removed");
        } catch { /* already removed or doesn't exist */ }
      }
      return;
    }

    // Don't nag more than once per day
    if (state.lastNaggedAt) {
      const elapsed = Date.now() - new Date(state.lastNaggedAt).getTime();
      if (elapsed < ONE_DAY_MS) return;
    }

    const incomplete = getIncompleteSteps(state);
    if (incomplete.length === 0) return;

    // Pick next step to nag about (rotate — don't nag same step twice in a row)
    // Prioritize pending over skipped
    const pending = incomplete.filter((s) => s.step.status === "pending");
    const pool = pending.length > 0 ? pending : incomplete;

    let target = pool[0];
    if (pool.length > 1 && state.lastNaggedStep === pool[0].id) {
      target = pool[1];
    }

    const message = NAG_MESSAGES[target.id] || `We still have "${target.id}" to finish in your setup.`;

    if (notifyCallback) {
      notifyCallback(`Hey, ${message}`);
    }

    // Escalate to Discord after 7+ nags (roughly 7 days since nags are daily)
    if (discordCallback && state.nagCount >= 7) {
      discordCallback(`📋 Onboarding reminder: ${message} (Say "continue onboarding" to pick up where we left off)`);
    }

    await recordNag(target.id);
  } catch (err) {
    console.error("[Onboarding] Checker error:", err instanceof Error ? err.message : err);
  }
}

export function canCheckOnboarding(): boolean {
  return true;
}
