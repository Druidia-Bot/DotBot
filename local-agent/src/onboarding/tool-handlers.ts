/**
 * Onboarding Tool Handlers
 * 
 * Handles onboarding.status, onboarding.complete_step, onboarding.skip_step
 */

import {
  onboardingExists,
  readOnboarding,
  initOnboarding,
  completeStep,
  skipStep,
  markNotApplicable,
  getIncompleteSteps,
  isOnboardingComplete,
  ONBOARDING_STEPS,
} from "./store.js";

const VALID_STEPS = new Set<string>(ONBOARDING_STEPS);

export async function handleOnboarding(
  toolId: string,
  args: Record<string, any>,
): Promise<{ success: boolean; output: string; error?: string }> {
  switch (toolId) {
    case "onboarding.status":
      return await onboardingStatus();

    case "onboarding.complete_step":
      return await onboardingCompleteStep(args.step);

    case "onboarding.skip_step":
      return await onboardingSkipStep(args.step);

    case "onboarding.mark_not_applicable":
      return await onboardingMarkNA(args.step);

    default:
      return { success: false, output: "", error: `Unknown onboarding tool: ${toolId}` };
  }
}

async function onboardingStatus(): Promise<{ success: boolean; output: string }> {
  if (!(await onboardingExists())) {
    const state = await initOnboarding();
    return {
      success: true,
      output: JSON.stringify({
        message: "Onboarding initialized — all steps pending",
        state,
      }),
    };
  }

  const state = await readOnboarding();
  const incomplete = getIncompleteSteps(state);
  const complete = isOnboardingComplete(state);

  return {
    success: true,
    output: JSON.stringify({
      complete,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      steps: state.steps,
      incompleteCount: incomplete.length,
      incompleteSteps: incomplete.map((s) => s.id),
    }),
  };
}

async function onboardingCompleteStep(
  step: string,
): Promise<{ success: boolean; output: string; error?: string }> {
  if (!step) {
    return { success: false, output: "", error: "Missing required parameter: step" };
  }

  if (!VALID_STEPS.has(step)) {
    return { success: false, output: "", error: `Unknown step "${step}". Valid steps: ${[...VALID_STEPS].join(", ")}` };
  }

  const state = await completeStep(step);
  const allDone = isOnboardingComplete(state);
  const remaining = getIncompleteSteps(state).map((s) => s.id);

  const message = allDone
    ? `Step "${step}" marked as completed — ALL ONBOARDING COMPLETE! Congratulations! All setup steps are done. DotBot is fully configured and ready to go.`
    : `Step "${step}" marked as completed`;

  return {
    success: true,
    output: JSON.stringify({ message, allDone, celebration: allDone, remaining }),
  };
}

async function onboardingSkipStep(
  step: string,
): Promise<{ success: boolean; output: string; error?: string }> {
  if (!step) {
    return { success: false, output: "", error: "Missing required parameter: step" };
  }
  if (!VALID_STEPS.has(step)) {
    return { success: false, output: "", error: `Unknown step "${step}". Valid steps: ${[...VALID_STEPS].join(", ")}` };
  }

  const state = await skipStep(step);

  return {
    success: true,
    output: JSON.stringify({
      message: `Step "${step}" skipped — will remind later`,
      remaining: getIncompleteSteps(state).map((s) => s.id),
    }),
  };
}

async function onboardingMarkNA(
  step: string,
): Promise<{ success: boolean; output: string; error?: string }> {
  if (!step) {
    return { success: false, output: "", error: "Missing required parameter: step" };
  }
  if (!VALID_STEPS.has(step)) {
    return { success: false, output: "", error: `Unknown step "${step}". Valid steps: ${[...VALID_STEPS].join(", ")}` };
  }

  const state = await markNotApplicable(step);

  return {
    success: true,
    output: JSON.stringify({
      message: `Step "${step}" marked as not applicable`,
      remaining: getIncompleteSteps(state).map((s) => s.id),
    }),
  };
}
