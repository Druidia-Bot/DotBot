/**
 * Onboarding Tool Definitions
 */

import type { DotBotTool } from "../../memory/types.js";

export const onboardingTools: DotBotTool[] = [
  {
    id: "onboarding.status",
    name: "onboarding_status",
    description: "Check the current onboarding progress. Returns which steps are completed, skipped, pending, or not applicable. Use this before starting or resuming onboarding to know where to pick up.",
    source: "core",
    category: "onboarding",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "onboarding.complete_step",
    name: "complete_onboarding_step",
    description: "Mark an onboarding step as completed. Call this after successfully finishing each onboarding phase.",
    source: "core",
    category: "onboarding",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        step: { type: "string", description: "Step ID: name_preference, phone_type, personality_transfer, discord_setup, brave_search, codegen_tools, systems_check, git_backup" },
      },
      required: ["step"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "onboarding.skip_step",
    name: "skip_onboarding_step",
    description: "Mark an onboarding step as skipped. The user will be gently reminded about it later.",
    source: "core",
    category: "onboarding",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        step: { type: "string", description: "Step ID to skip" },
      },
      required: ["step"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "onboarding.mark_not_applicable",
    name: "mark_onboarding_not_applicable",
    description: "Mark an onboarding step as not applicable (e.g., user doesn't have a Claude subscription for codegen_tools). Will never be nagged about.",
    source: "core",
    category: "onboarding",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        step: { type: "string", description: "Step ID to mark as N/A" },
      },
      required: ["step"],
    },
    annotations: { destructiveHint: true },
  },
];
