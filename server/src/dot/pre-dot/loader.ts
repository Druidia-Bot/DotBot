/**
 * Principle Loader
 *
 * Reads .md principle files from the principles directory,
 * parses YAML frontmatter, and returns structured PrincipleFile objects.
 */

import { readdir, readFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createComponentLogger } from "#logging.js";
import type { PrincipleFile } from "./types.js";

const log = createComponentLogger("dot.loader");

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PRINCIPLES_DIR = resolve(__dirname, "..", "principles");

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } | null {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return null;

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      meta[key] = val;
    }
  }

  return { meta, body: match[2].trim() };
}

/** Load all principle .md files from the principles directory. */
export async function loadPrinciples(): Promise<PrincipleFile[]> {
  try {
    const files = await readdir(PRINCIPLES_DIR);
    const mdFiles = files.filter(f => f.endsWith(".md")).sort();

    const principles: PrincipleFile[] = [];
    for (const filename of mdFiles) {
      const raw = await readFile(resolve(PRINCIPLES_DIR, filename), "utf-8");
      const parsed = parseFrontmatter(raw);
      if (!parsed || !parsed.meta.id || !parsed.meta.summary) {
        log.warn("Skipping principle file with missing frontmatter", { filename });
        continue;
      }
      const fileType = parsed.meta.type === "rule" ? "rule" as const : "principle" as const;
      const triggers = parsed.meta.triggers
        ? parsed.meta.triggers.split(",").map((t: string) => t.trim()).filter(Boolean)
        : [];
      principles.push({
        id: parsed.meta.id,
        summary: parsed.meta.summary,
        type: fileType,
        triggers,
        body: parsed.body,
      });
    }

    log.info("Loaded principles", { count: principles.length });
    return principles;
  } catch (err) {
    log.error("Failed to load principles", { error: err });
    return [];
  }
}
