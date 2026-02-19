/**
 * Conflict Detector — LLM-based rule contradiction check.
 *
 * When a rule is added via rules.add_rule or edited via rules.edit_rule,
 * this module checks if the new rule contradicts any existing rules.
 *
 * Uses serverLLMCall() with the workhorse model role — same mechanism
 * used by the evaluation engine.
 */

import { serverLLMCall } from "../../server-llm.js";
import type { Rule, ConflictReport } from "./types.js";

/**
 * Check if a new rule conflicts with existing rules.
 *
 * Returns a ConflictReport. If conflict is false, the rule is safe to add.
 */
export async function checkConflicts(
  newRule: Omit<Rule, "id">,
  existingRules: Rule[],
  rulesetName: string,
): Promise<ConflictReport> {
  if (existingRules.length === 0) {
    return {
      conflict: false,
      conflicting_rule_ids: [],
      new_rule_assess: newRule.assess,
      description: "",
      suggested_resolutions: [],
    };
  }

  const existingRulesText = existingRules.map(r =>
    `[${r.id}] "${r.assess}" → scale ${r.scale[0]}-${r.scale[1]}, threshold ${r.threshold}` +
    (r.when_above ? `, ABOVE: "${r.when_above}"` : "") +
    (r.when_below ? `, BELOW: "${r.when_below}"` : ""),
  ).join("\n");

  const newRuleText =
    `"${newRule.assess}" → scale ${newRule.scale[0]}-${newRule.scale[1]}, threshold ${newRule.threshold}` +
    (newRule.when_above ? `, ABOVE: "${newRule.when_above}"` : "") +
    (newRule.when_below ? `, BELOW: "${newRule.when_below}"` : "");

  const prompt = `You are checking for conflicts between rules in a processing ruleset called "${rulesetName}".

## Existing Rules
${existingRulesText}

## New Rule Being Added
${newRuleText}

## What counts as a conflict?
A conflict exists when two rules could produce CONTRADICTORY actions on the same item:
- Filing in two different folders
- Both "archive" and "keep in inbox"
- Both "ignore" and "flag as urgent"

These are NOT conflicts (additive actions are fine):
- Label "client" AND label "urgent" → both apply
- Summarize AND draft a response → both apply
- Multiple rules that fire on different items → no conflict

## Response Format
Respond with ONLY a JSON object, no markdown, no explanation:
{
  "conflict": true/false,
  "conflicting_rule_ids": ["r1"],
  "new_rule_assess": "the new rule's assess text",
  "description": "Explain the conflict in one sentence",
  "suggested_resolutions": [
    "Resolution option 1",
    "Resolution option 2",
    "Resolution option 3"
  ]
}

If no conflict, return: { "conflict": false, "conflicting_rule_ids": [], "new_rule_assess": "...", "description": "", "suggested_resolutions": [] }`;

  try {
    const result = await serverLLMCall({
      role: "workhorse",
      messages: [
        { role: "user", content: prompt },
      ],
      maxTokens: 1024,
      temperature: 0.1,
    });

    if (!result.success || !result.content) {
      // If LLM fails, don't block — allow the rule with a warning
      return {
        conflict: false,
        conflicting_rule_ids: [],
        new_rule_assess: newRule.assess,
        description: "Warning: conflict check failed (LLM unavailable). Rule added without validation.",
        suggested_resolutions: [],
      };
    }

    // Parse the LLM response
    const cleaned = result.content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const report: ConflictReport = JSON.parse(cleaned);
    report.new_rule_assess = newRule.assess;
    return report;
  } catch (err) {
    // Parse failure or network error — don't block
    return {
      conflict: false,
      conflicting_rule_ids: [],
      new_rule_assess: newRule.assess,
      description: `Warning: conflict check failed (${err instanceof Error ? err.message : "unknown error"}). Rule added without validation.`,
      suggested_resolutions: [],
    };
  }
}
