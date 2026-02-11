/**
 * Onboarding Store — CRUD for ~/.bot/onboarding.json
 * 
 * Tracks onboarding progress across sessions. Each step can be
 * pending, completed, skipped, or not_applicable.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { DOTBOT_DIR, fileExists } from "../memory/store-core.js";

export const ONBOARDING_PATH = path.join(DOTBOT_DIR, "onboarding.json");

export type StepStatus = "pending" | "completed" | "skipped" | "not_applicable";

export interface OnboardingStep {
  status: StepStatus;
  completedAt: string | null;
  skippedAt: string | null;
}

export interface OnboardingState {
  startedAt: string;
  completedAt: string | null;
  steps: Record<string, OnboardingStep>;
  lastNaggedAt: string | null;
  lastNaggedStep: string | null;
  nagCount: number;
}

export const ONBOARDING_STEPS = [
  "name_preference",
  "phone_type",
  "personality_transfer",
  "discord_setup",
  "brave_search",
  "codegen_tools",
  "systems_check",
  "git_backup",
] as const;

export type OnboardingStepId = typeof ONBOARDING_STEPS[number];

function makeDefaultState(): OnboardingState {
  const steps: Record<string, OnboardingStep> = {};
  for (const id of ONBOARDING_STEPS) {
    steps[id] = { status: "pending", completedAt: null, skippedAt: null };
  }
  return {
    startedAt: new Date().toISOString(),
    completedAt: null,
    steps,
    lastNaggedAt: null,
    lastNaggedStep: null,
    nagCount: 0,
  };
}

export async function onboardingExists(): Promise<boolean> {
  return fileExists(ONBOARDING_PATH);
}

export async function readOnboarding(): Promise<OnboardingState> {
  try {
    const raw = await fs.readFile(ONBOARDING_PATH, "utf-8");
    return JSON.parse(raw) as OnboardingState;
  } catch {
    return makeDefaultState();
  }
}

export async function writeOnboarding(state: OnboardingState): Promise<void> {
  await fs.writeFile(ONBOARDING_PATH, JSON.stringify(state, null, 2), "utf-8");
}

export async function initOnboarding(): Promise<OnboardingState> {
  const state = makeDefaultState();
  await writeOnboarding(state);
  return state;
}

export async function completeStep(stepId: string): Promise<OnboardingState> {
  const state = await readOnboarding();
  if (state.steps[stepId]) {
    state.steps[stepId].status = "completed";
    state.steps[stepId].completedAt = new Date().toISOString();
  } else {
    console.warn(`[Onboarding] completeStep called with unknown step: "${stepId}"`);
  }
  checkAllComplete(state);
  await writeOnboarding(state);
  return state;
}

export async function skipStep(stepId: string): Promise<OnboardingState> {
  const state = await readOnboarding();
  if (state.steps[stepId]) {
    state.steps[stepId].status = "skipped";
    state.steps[stepId].skippedAt = new Date().toISOString();
  } else {
    console.warn(`[Onboarding] skipStep called with unknown step: "${stepId}"`);
  }
  checkAllComplete(state);
  await writeOnboarding(state);
  return state;
}

export async function markNotApplicable(stepId: string): Promise<OnboardingState> {
  const state = await readOnboarding();
  if (state.steps[stepId]) {
    state.steps[stepId].status = "not_applicable";
  } else {
    console.warn(`[Onboarding] markNotApplicable called with unknown step: "${stepId}"`);
  }
  checkAllComplete(state);
  await writeOnboarding(state);
  return state;
}

export async function recordNag(stepId: string): Promise<OnboardingState> {
  const state = await readOnboarding();
  state.lastNaggedAt = new Date().toISOString();
  state.lastNaggedStep = stepId;
  state.nagCount++;
  await writeOnboarding(state);
  return state;
}

export function getIncompleteSteps(state: OnboardingState): { id: string; step: OnboardingStep }[] {
  return Object.entries(state.steps)
    .filter(([, step]) => step.status === "pending" || step.status === "skipped")
    .map(([id, step]) => ({ id, step }));
}

export function isOnboardingComplete(state: OnboardingState): boolean {
  return Object.values(state.steps).every(
    (s) => s.status === "completed" || s.status === "not_applicable"
  );
}

function checkAllComplete(state: OnboardingState): void {
  if (!state.completedAt && isOnboardingComplete(state)) {
    state.completedAt = new Date().toISOString();
  }
}
