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
  completeStep,
  recordNag,
  getIncompleteSteps,
  isOnboardingComplete,
  type OnboardingState,
} from "./store.js";
import { vaultHas } from "../credential-vault.js";
import { loadIdentity } from "../memory/store-identity.js";
import { fileExists, DOTBOT_DIR } from "../memory/store-core.js";
import type { PeriodicTaskDef } from "../periodic/index.js";

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
let sendPromptCallback: ((message: string) => void) | null = null;

export function setOnboardingNotifyCallback(cb: (message: string) => void): void {
  notifyCallback = cb;
}

export function setOnboardingDiscordCallback(cb: (message: string) => void): void {
  discordCallback = cb;
}

export function setOnboardingSendPromptCallback(cb: (message: string) => void): void {
  sendPromptCallback = cb;
}

/**
 * Check onboarding status and nag if needed.
 * Called by the periodic task manager.
 */
let skillDeletedFlag = false;

/**
 * Auto-detect completed steps by checking real system state.
 * Marks steps complete if their underlying work is actually done.
 */
async function autoDetectCompletedSteps(state: OnboardingState): Promise<boolean> {
  let changed = false;

  const pending = (id: string) => state.steps[id]?.status === "pending" || state.steps[id]?.status === "skipped";

  // name_preference: identity exists with version > 1 (user interacted with it)
  if (pending("name_preference")) {
    try {
      const identity = await loadIdentity();
      if (identity && identity.version > 1) {
        await completeStep("name_preference");
        state.steps["name_preference"] = { status: "completed", completedAt: new Date().toISOString(), skippedAt: null };
        changed = true;
      }
    } catch { /* ignore */ }
  }

  // phone_type: user profile mental model exists (personality transfer captures this)
  if (pending("phone_type")) {
    try {
      const modelsDir = join(homedir(), ".bot", "memory", "models");
      const files = await fs.readdir(modelsDir);
      const hasProfile = files.some(f => f.includes("profile") || f.includes("user"));
      if (hasProfile) {
        await completeStep("phone_type");
        state.steps["phone_type"] = { status: "completed", completedAt: new Date().toISOString(), skippedAt: null };
        changed = true;
      }
    } catch { /* ignore */ }
  }

  // personality_transfer: backstory.md exists
  if (pending("personality_transfer")) {
    try {
      const backstoryPath = join(DOTBOT_DIR, "backstory.md");
      if (await fileExists(backstoryPath)) {
        await completeStep("personality_transfer");
        state.steps["personality_transfer"] = { status: "completed", completedAt: new Date().toISOString(), skippedAt: null };
        changed = true;
      }
    } catch { /* ignore */ }
  }

  // discord_setup: token in vault + channel config in env
  if (pending("discord_setup")) {
    try {
      const hasToken = await vaultHas("DISCORD_BOT_TOKEN");
      const hasChannel = !!process.env.DISCORD_CHANNEL_CONVERSATION;
      if (hasToken && hasChannel) {
        await completeStep("discord_setup");
        state.steps["discord_setup"] = { status: "completed", completedAt: new Date().toISOString(), skippedAt: null };
        changed = true;
      }
    } catch { /* ignore */ }
  }

  // brave_search: API key in vault
  if (pending("brave_search")) {
    try {
      if (await vaultHas("BRAVE_SEARCH_API_KEY")) {
        await completeStep("brave_search");
        state.steps["brave_search"] = { status: "completed", completedAt: new Date().toISOString(), skippedAt: null };
        changed = true;
      }
    } catch { /* ignore */ }
  }

  // git_backup: .git directory exists in ~/.bot/
  if (pending("git_backup")) {
    try {
      const gitDir = join(DOTBOT_DIR, ".git");
      if (await fileExists(gitDir)) {
        await completeStep("git_backup");
        state.steps["git_backup"] = { status: "completed", completedAt: new Date().toISOString(), skippedAt: null };
        changed = true;
      }
    } catch { /* ignore */ }
  }

  return changed;
}

export async function checkOnboarding(): Promise<void> {
  try {
    if (!(await onboardingExists())) return;

    let state = await readOnboarding();

    // Auto-detect steps that are actually done but not marked
    const detected = await autoDetectCompletedSteps(state);
    if (detected) {
      state = await readOnboarding(); // re-read after mutations
      console.log("[Onboarding] Auto-detected completed steps");
    }

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

    const fullMessage =
      `[Onboarding Reminder] Incomplete step: ${target.id}\n` +
      `${message}\n` +
      `After completing this step, call onboarding.complete_step({ step: "${target.id}" }) to mark it done.`;

    // Send as a prompt into Dot's conversation so she has context
    if (sendPromptCallback) {
      sendPromptCallback(fullMessage);
    }

    // Also post to Discord #updates for visibility
    if (notifyCallback) {
      notifyCallback(fullMessage);
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

/**
 * Returns the periodic task definition for the onboarding checker.
 * Config is co-located here; post-auth-init just collects it.
 */
export function getPeriodicTaskDef(): PeriodicTaskDef {
  return {
    id: "onboarding-check",
    name: "Onboarding Check",
    intervalMs: 60 * 60 * 1000, // Check once per hour (nag logic limits to once/day)
    initialDelayMs: 5 * 60 * 1000, // 5 minutes after startup
    enabled: true,
    run: () => checkOnboarding(),
    canRun: canCheckOnboarding,
  };
}
