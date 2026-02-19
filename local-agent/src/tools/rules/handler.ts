/**
 * Rules Tool Handler — Routes rules.* tool calls.
 */

import type { ToolExecResult } from "../tool-executor.js";
import { listRulesets, readRuleset, saveRuleset, deleteRuleset, addRule, removeRule, removeRuleForEdit } from "./store.js";
import { checkConflicts } from "./conflict.js";
import { evaluateRuleset } from "./engine.js";
import type { Ruleset, Rule } from "./types.js";

export async function handleRules(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {

    // ────────────────────────────────────────────
    // rules.list
    // ────────────────────────────────────────────
    case "rules.list": {
      const rulesets = await listRulesets();
      if (rulesets.length === 0) {
        return { success: true, output: JSON.stringify({ rulesets: [], message: "No rulesets found. Use rules.save to create one." }, null, 2) };
      }
      return { success: true, output: JSON.stringify({ rulesets }, null, 2) };
    }

    // ────────────────────────────────────────────
    // rules.read
    // ────────────────────────────────────────────
    case "rules.read": {
      const slug = args.slug as string;
      if (!slug) return { success: false, output: "", error: "slug is required" };

      const ruleset = await readRuleset(slug);
      if (!ruleset) return { success: false, output: "", error: `Ruleset "${slug}" not found` };

      return { success: true, output: JSON.stringify(ruleset, null, 2) };
    }

    // ────────────────────────────────────────────
    // rules.save (full overwrite, no conflict check)
    // ────────────────────────────────────────────
    case "rules.save": {
      const { name, slug, description, rules } = args;
      if (!name || !slug || !description) {
        return { success: false, output: "", error: "name, slug, and description are required" };
      }
      if (!Array.isArray(rules)) {
        return { success: false, output: "", error: "rules must be an array" };
      }

      const ruleset: Ruleset = { name, slug, description, rules };
      await saveRuleset(ruleset);
      return {
        success: true,
        output: JSON.stringify({
          saved: true,
          slug,
          ruleCount: rules.length,
          message: `Ruleset "${name}" saved with ${rules.length} rules.`,
        }, null, 2),
      };
    }

    // ────────────────────────────────────────────
    // rules.delete
    // ────────────────────────────────────────────
    case "rules.delete": {
      const slug = args.slug as string;
      if (!slug) return { success: false, output: "", error: "slug is required" };

      const deleted = await deleteRuleset(slug);
      if (!deleted) return { success: false, output: "", error: `Ruleset "${slug}" not found` };

      return { success: true, output: JSON.stringify({ deleted: true, slug }, null, 2) };
    }

    // ────────────────────────────────────────────
    // rules.add_rule (with conflict detection)
    // ────────────────────────────────────────────
    case "rules.add_rule": {
      const { slug, assess, scale, threshold, when_above, when_below } = args;
      if (!slug) return { success: false, output: "", error: "slug is required" };
      if (!assess) return { success: false, output: "", error: "assess is required" };
      if (!scale || !Array.isArray(scale)) return { success: false, output: "", error: "scale is required (e.g., [0, 1])" };
      if (threshold === undefined) return { success: false, output: "", error: "threshold is required" };

      const ruleset = await readRuleset(slug);
      if (!ruleset) return { success: false, output: "", error: `Ruleset "${slug}" not found` };

      const newRule: Omit<Rule, "id"> = {
        assess,
        scale: scale as [number, number],
        threshold,
        when_above: when_above || null,
        when_below: when_below || null,
      };

      // Run conflict detection
      const report = await checkConflicts(newRule, ruleset.rules, ruleset.name);
      if (report.conflict) {
        return {
          success: false,
          output: JSON.stringify({
            ...report,
            hint: "Resolve the conflict, then use rules.save to rewrite the full ruleset with updated rules.",
          }, null, 2),
          error: "Conflict detected — rule NOT saved",
        };
      }

      // No conflict — add the rule
      const { ruleId } = await addRule(slug, newRule);
      return {
        success: true,
        output: JSON.stringify({
          added: true,
          ruleId,
          slug,
          ruleCount: ruleset.rules.length + 1,
          conflictCheck: report.description || "No conflicts detected.",
        }, null, 2),
      };
    }

    // ────────────────────────────────────────────
    // rules.remove_rule
    // ────────────────────────────────────────────
    case "rules.remove_rule": {
      const { slug, ruleId } = args;
      if (!slug) return { success: false, output: "", error: "slug is required" };
      if (!ruleId) return { success: false, output: "", error: "ruleId is required" };

      try {
        const updated = await removeRule(slug, ruleId);
        return {
          success: true,
          output: JSON.stringify({
            removed: true,
            ruleId,
            slug,
            remainingRules: updated.rules.length,
          }, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    }

    // ────────────────────────────────────────────
    // rules.edit_rule (remove + conflict check + re-add)
    // ────────────────────────────────────────────
    case "rules.edit_rule": {
      const { slug, ruleId, assess, scale, threshold, when_above, when_below } = args;
      if (!slug) return { success: false, output: "", error: "slug is required" };
      if (!ruleId) return { success: false, output: "", error: "ruleId is required" };
      if (!assess) return { success: false, output: "", error: "assess is required" };

      try {
        // Remove the old rule temporarily
        const { ruleset } = await removeRuleForEdit(slug, ruleId);

        const editedRule: Omit<Rule, "id"> = {
          assess,
          scale: scale as [number, number],
          threshold,
          when_above: when_above || null,
          when_below: when_below || null,
        };

        // Check conflicts with remaining rules
        const report = await checkConflicts(editedRule, ruleset.rules, ruleset.name);
        if (report.conflict) {
          // Don't save — restore by re-reading from disk (removeRuleForEdit didn't persist)
          return {
            success: false,
            output: JSON.stringify({
              ...report,
              hint: "The edited rule conflicts with remaining rules. Use rules.save to rewrite the full ruleset.",
            }, null, 2),
            error: "Conflict detected — edit NOT saved",
          };
        }

        // No conflict — build final state in memory and save once (avoids two-write race)
        const fullRule: Rule = { id: ruleId, ...editedRule };
        ruleset.rules.push(fullRule);
        await saveRuleset(ruleset);

        return {
          success: true,
          output: JSON.stringify({
            edited: true,
            ruleId,
            slug,
            conflictCheck: report.description || "No conflicts detected.",
          }, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    }

    // ────────────────────────────────────────────
    // rules.evaluate
    // ────────────────────────────────────────────
    case "rules.evaluate": {
      const { slug, collectionId, items, confirmed } = args;
      if (!slug) return { success: false, output: "", error: "slug is required" };

      try {
        const result = await evaluateRuleset({
          slug,
          collectionId,
          items,
          confirmed: !!confirmed,
        });
        return { success: true, output: result };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    }

    default:
      return { success: false, output: "", error: `Unknown rules tool: ${toolId}` };
  }
}
