/**
 * Ruleset Tool Definitions — 8 tools in the rules.* namespace.
 */

import type { DotBotTool } from "../../memory/types.js";

export const rulesTools: DotBotTool[] = [
  {
    id: "rules.list",
    name: "rules_list",
    description:
      "List all rulesets in ~/.bot/rulesets/. Returns slug, name, description, and rule count for each.",
    source: "core",
    category: "rules",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
  {
    id: "rules.read",
    name: "rules_read",
    description: "Read a specific ruleset by slug. Returns all rules with their assess text, scales, thresholds, and actions.",
    source: "core",
    category: "rules",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Ruleset slug (e.g., 'email-triage')" },
      },
      required: ["slug"],
    },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
  {
    id: "rules.save",
    name: "rules_save",
    description:
      "Full overwrite of a ruleset. Used after conflict resolution when you need to rewrite " +
      "multiple rules atomically. Does NOT run conflict check — you are responsible for pre-validation. " +
      "Pass the complete ruleset object with name, slug, description, and all rules.",
    source: "core",
    category: "rules",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Ruleset display name" },
        slug: { type: "string", description: "Ruleset slug (filesystem-safe identifier)" },
        description: { type: "string", description: "What this ruleset does" },
        rules: {
          type: "array",
          description: "Complete list of rules",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Rule ID (e.g., 'r1')" },
              assess: { type: "string", description: "Assessment question" },
              scale: { type: "array", description: "Score range [min, max]", items: { type: "number" } },
              threshold: { type: "number", description: "Score threshold for when_above" },
              when_above: { type: "string", description: "Action when score >= threshold" },
              when_below: { type: "string", description: "Action when score < threshold (optional)" },
            },
            required: ["id", "assess", "scale", "threshold"],
          },
        },
      },
      required: ["name", "slug", "description", "rules"],
    },
    annotations: { mutatingHint: true, destructiveHint: true },
  },
  {
    id: "rules.delete",
    name: "rules_delete",
    description: "Delete an entire ruleset by slug. Removes the file from disk. This cannot be undone.",
    source: "core",
    category: "rules",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Ruleset slug to delete" },
      },
      required: ["slug"],
    },
    annotations: { mutatingHint: true, destructiveHint: true },
  },
  {
    id: "rules.add_rule",
    name: "rules_add_rule",
    description:
      "Add a single rule to a ruleset. Automatically runs conflict detection against existing rules " +
      "before saving. If a conflict is found, the rule is NOT saved — instead you receive a conflict " +
      "report with suggested resolutions. Resolve the conflict, then use rules.save to rewrite the " +
      "full ruleset with the conflicting rules updated.",
    source: "core",
    category: "rules",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Ruleset slug to add the rule to" },
        assess: { type: "string", description: "The assessment question (e.g., 'Is this a promotional newsletter?')" },
        scale: { type: "array", description: "Score range: [0, 1] for binary, [1, 10] for graduated", items: { type: "number" } },
        threshold: { type: "number", description: "Score >= threshold triggers when_above" },
        when_above: { type: "string", description: "Natural language action when score meets threshold" },
        when_below: { type: "string", description: "Optional action when score is below threshold" },
      },
      required: ["slug", "assess", "scale", "threshold"],
    },
    annotations: { mutatingHint: true },
  },
  {
    id: "rules.remove_rule",
    name: "rules_remove_rule",
    description:
      "Remove a single rule by ID from a ruleset. Safer than rules.save for deletions — avoids " +
      "the risk of accidentally dropping other rules during a full rewrite.",
    source: "core",
    category: "rules",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Ruleset slug" },
        ruleId: { type: "string", description: "Rule ID to remove (e.g., 'r3')" },
      },
      required: ["slug", "ruleId"],
    },
    annotations: { mutatingHint: true },
  },
  {
    id: "rules.edit_rule",
    name: "rules_edit_rule",
    description:
      "Edit an existing rule. Internally removes the old version and re-adds the new one through " +
      "conflict detection, catching cases where the edit introduces a new conflict.",
    source: "core",
    category: "rules",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Ruleset slug" },
        ruleId: { type: "string", description: "Rule ID to edit (e.g., 'r2')" },
        assess: { type: "string", description: "Updated assessment question" },
        scale: { type: "array", description: "Updated score range", items: { type: "number" } },
        threshold: { type: "number", description: "Updated threshold" },
        when_above: { type: "string", description: "Updated action for above threshold" },
        when_below: { type: "string", description: "Updated action for below threshold" },
      },
      required: ["slug", "ruleId", "assess", "scale", "threshold"],
    },
    annotations: { mutatingHint: true },
  },
  {
    id: "rules.evaluate",
    name: "rules_evaluate",
    description:
      "Run a ruleset against a collection of items. Each item is scored against every rule using " +
      "the workhorse LLM model. Pass either a collectionId (from a previous MCP tool result) or " +
      "inline items. Returns a structured action plan showing which rules fired on which items.\n\n" +
      "If the collection has >50 items, returns a confirmation prompt first (call again with confirmed: true). " +
      "Hard cap at 500 items.",
    source: "core",
    category: "rules",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Ruleset slug to evaluate" },
        collectionId: { type: "string", description: "Collection ID from a previous tool result (alternative to items)" },
        items: {
          type: "array",
          description: "Inline items to evaluate (alternative to collectionId)",
          items: { type: "object" },
        },
        confirmed: { type: "boolean", description: "Set to true to confirm large batch evaluation (>50 items)" },
      },
      required: ["slug"],
    },
    annotations: { mutatingHint: false },
  },
];
