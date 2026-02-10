/**
 * Format Fixer
 * 
 * Processes malformed persona/council .md files by sending them to the
 * server for AI-powered correction. After receiving corrected content,
 * writes it back to disk and re-runs validation.
 * 
 * Flow:
 * 1. Startup validation detects malformed files
 * 2. User is asked if they want AI correction
 * 3. After server connection, this module sends each file for correction
 * 4. Server uses LLM to reformat, returns corrected content
 * 5. Corrected files are written to disk
 * 6. Validation is re-run to pick up the fixed files
 */

import { nanoid } from "nanoid";
import * as fs from "fs/promises";
import * as path from "path";
import type { WSMessage } from "../types.js";
import type { MalformedFile } from "../memory/startup-validator.js";
import { runStartupValidation, printValidationReport } from "../memory/startup-validator.js";

// ============================================
// TEMPLATES (sent to server so LLM knows the expected format)
// ============================================

const PERSONA_MD_TEMPLATE = `---
id: my-persona
name: My Persona
modelTier: smart
description: A short description of what this persona does
tools: [knowledge, http]
role: The role this persona fills
traits: [trait1, trait2]
expertise: [area1, area2]
triggers: [keyword1, keyword2]
---

The system prompt / instructions for this persona go here as the body content.
This is the persona's systemPrompt field.`;

const COUNCIL_MD_TEMPLATE = `---
slug: my-council
name: My Council
handles:
  - topic1
  - topic2
tags:
  - tag1
  - tag2
---

## Mission

A description of this council's mission.

## Members

### 1. @persona-id — Role description
- Responsibilities and capabilities`;

// ============================================
// PUBLIC API
// ============================================

/**
 * Send each malformed file to the server for AI correction.
 * Uses the sendAndWait pattern (same as sleep cycle condense requests).
 */
export async function processFormatFixes(
  files: MalformedFile[],
  sendAndWait: (message: WSMessage) => Promise<any>
): Promise<void> {
  console.log(`\n[FormatFixer] Attempting AI correction of ${files.length} file(s)...`);

  let fixed = 0;
  let failed = 0;

  for (const file of files) {
    const basename = path.basename(file.filePath);
    const template = file.fileType === "persona" ? PERSONA_MD_TEMPLATE : COUNCIL_MD_TEMPLATE;

    try {
      const response = await sendAndWait({
        type: "format_fix_request",
        id: nanoid(),
        timestamp: Date.now(),
        payload: {
          filePath: file.filePath,
          fileType: file.fileType,
          content: file.content,
          errors: file.errors,
          template,
        },
      });

      if (response?.correctedContent) {
        await fs.writeFile(file.filePath, response.correctedContent, "utf-8");
        console.log(`  [FormatFixer] Fixed: ${basename}`);
        fixed++;
      } else {
        console.warn(`  [FormatFixer] Could not fix: ${basename} — no corrected content returned`);
        failed++;
      }
    } catch (err) {
      console.warn(`  [FormatFixer] Error fixing ${basename}: ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }

  console.log(`[FormatFixer] Done: ${fixed} fixed, ${failed} failed.`);

  // Re-run validation to pick up the corrected files
  if (fixed > 0) {
    console.log("[FormatFixer] Re-running validation to pick up corrected files...");
    const result = await runStartupValidation();
    printValidationReport(result);
  }
}
