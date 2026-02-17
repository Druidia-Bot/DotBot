/**
 * Prompt Template Helper
 *
 * Reads .md prompt files and injects values into |* Field *| placeholders.
 * 
 * Usage:
 *   const prompt = await loadPrompt("pipeline/intake/intake.md", {
 *     "Identity": identitySection,
 *     "Conversation History": historySection,
 *   });
 */

import { readFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createComponentLogger } from "#logging.js";

const log = createComponentLogger("prompt-template");

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load a prompt template from a .md file relative to src/ and inject field values.
 *
 * Placeholders use the format: |* FieldName *|
 * Fields are matched case-insensitively.
 *
 * @param relativePath Path relative to src/ (e.g. "intake/intake.md")
 * @param fields Key-value map of field names to inject
 * @returns The rendered prompt string
 */
export async function loadPrompt(
  relativePath: string,
  fields: Record<string, string>
): Promise<string> {
  const fullPath = resolve(__dirname, relativePath);

  let template: string;
  try {
    template = await readFile(fullPath, "utf-8");
  } catch (e) {
    log.error("Failed to read prompt template", { path: fullPath, error: e });
    throw new Error(`Prompt template not found: ${fullPath}`);
  }

  // Replace all |* FieldName *| placeholders
  const rendered = template.replace(
    /\|\*\s*([^*]+?)\s*\*\|/g,
    (_match, fieldName: string) => {
      const key = fieldName.trim();
      // Case-insensitive lookup
      const entry = Object.entries(fields).find(
        ([k]) => k.toLowerCase() === key.toLowerCase()
      );
      if (entry) {
        return entry[1];
      }
      log.warn("Unresolved prompt placeholder", { field: key, template: relativePath });
      return `[MISSING: ${key}]`;
    }
  );

  return rendered;
}

/**
 * Load a JSON schema file relative to src/.
 *
 * @param relativePath Path relative to src/ (e.g. "intake/intake.schema.json")
 * @returns Parsed JSON object
 */
export async function loadSchema(relativePath: string): Promise<Record<string, unknown>> {
  const fullPath = resolve(__dirname, relativePath);

  try {
    const raw = await readFile(fullPath, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    log.error("Failed to read schema file", { path: fullPath, error: e });
    throw new Error(`Schema not found: ${fullPath}`);
  }
}
