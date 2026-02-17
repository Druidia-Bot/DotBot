/**
 * Journal — File Store
 *
 * Handles reading, writing, and listing journal files on disk.
 * Journal files live at ~/.bot/memory/journal/YYYY-MM-DD.md
 */

import { promises as fs } from "fs";
import { join } from "path";
import { JOURNAL_DIR, formatDate } from "./helpers.js";

/**
 * List available journal files (most recent first).
 */
export async function listJournalFiles(): Promise<string[]> {
  try {
    await fs.mkdir(JOURNAL_DIR, { recursive: true });
    const files = await fs.readdir(JOURNAL_DIR);
    return files
      .filter(f => f.endsWith(".md"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Read a specific journal file by date (YYYY-MM-DD).
 * Returns null if the file doesn't exist.
 */
export async function readJournal(date: string): Promise<string | null> {
  try {
    const journalPath = join(JOURNAL_DIR, `${date}.md`);
    return await fs.readFile(journalPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Write a journal section to the file for a given date.
 * Creates the file with a header if it doesn't exist, or appends.
 */
export async function writeJournalSection(date: string, section: string, existingJournal: string): Promise<void> {
  await fs.mkdir(JOURNAL_DIR, { recursive: true });
  const journalPath = join(JOURNAL_DIR, `${date}.md`);

  if (!existingJournal) {
    const header = `# Assistant's Log — ${formatDate(date)}\n\n`;
    await fs.writeFile(journalPath, header + section, "utf-8");
  } else {
    await fs.appendFile(journalPath, "\n\n" + section, "utf-8");
  }
}
