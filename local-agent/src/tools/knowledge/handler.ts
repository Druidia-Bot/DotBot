/**
 * Knowledge Management Handler
 *
 * Knowledge documents are stored as JSON files with a _meta key for metadata
 * and free-form keys for knowledge content. This enables structural skeleton
 * extraction: on first turn the LLM sees just the keys and truncated values,
 * then requests specific sections on demand.
 *
 * Storage:
 *   General:  ~/.bot/knowledge/{slug}.json
 *   Persona:  ~/.bot/personas/{slug}/knowledge/{slug}.json
 */

import { promises as fs } from "fs";
import { resolve, join } from "path";
import * as os from "os";
import type { ToolExecResult } from "../_shared/types.js";
import {
  getPersona,
  addKnowledge as addPersonaKnowledge,
  listKnowledge as listPersonaKnowledge,
  getKnowledge as getPersonaKnowledge,
} from "../../memory/personas.js";

// ============================================
// PATHS
// ============================================

const DOTBOT_DIR = resolve(os.homedir(), ".bot");
const GENERAL_KNOWLEDGE_DIR = join(DOTBOT_DIR, "knowledge");
const PERSONAS_DIR = join(DOTBOT_DIR, "personas");

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ============================================
// SKELETON BUILDER
// ============================================

/**
 * Build a compact skeleton from a knowledge JSON object.
 * Shows keys with truncated values so the LLM can decide what to request.
 *
 * Rules:
 *   - Strings <150 chars → inline verbatim
 *   - Strings ≥150 chars → first 120 chars + " ... (N words)"
 *   - Arrays ≤3 items (all short strings) → inline
 *   - Arrays >3 items → first 3 items + " ... +N more"
 *   - Objects → recurse (max depth 2), show keys
 *   - _meta key → show title, tags, source_type only
 */
export function buildKnowledgeSkeleton(doc: Record<string, any>, indent = 0): string {
  const pad = "  ".repeat(indent);
  const lines: string[] = [];

  for (const [key, value] of Object.entries(doc)) {
    if (key === "_meta") {
      const m = value as Record<string, any>;
      const tags = Array.isArray(m.tags) && m.tags.length > 0 ? ` [${m.tags.join(", ")}]` : "";
      const src = m.source_type ? ` (${m.source_type})` : "";
      lines.push(`${pad}${m.title || "Untitled"}${src}${tags}`);
      if (m.description) lines.push(`${pad}  ${m.description}`);
      continue;
    }

    if (value === null || value === undefined) {
      lines.push(`${pad}${key}: null`);
    } else if (typeof value === "string") {
      lines.push(`${pad}${key}: ${truncateString(value)}`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      lines.push(`${pad}${key}: ${value}`);
    } else if (Array.isArray(value)) {
      lines.push(`${pad}${key}: ${truncateArray(value)}`);
    } else if (typeof value === "object" && indent < 2) {
      const childKeys = Object.keys(value);
      if (childKeys.length <= 4) {
        lines.push(`${pad}${key}:`);
        lines.push(buildKnowledgeSkeleton(value, indent + 1));
      } else {
        const preview = childKeys.slice(0, 4).join(", ");
        lines.push(`${pad}${key}: {${preview}, ... +${childKeys.length - 4} more keys}`);
      }
    } else if (typeof value === "object") {
      const childKeys = Object.keys(value);
      lines.push(`${pad}${key}: {${childKeys.length} keys}`);
    }
  }

  return lines.filter(l => l.trim()).join("\n");
}

function truncateString(s: string): string {
  const clean = s.replace(/\n/g, " ").trim();
  if (clean.length < 150) return clean;
  const wordCount = s.split(/\s+/).length;
  return `${clean.slice(0, 120)}... (${wordCount} words)`;
}

function truncateArray(arr: any[]): string {
  if (arr.length === 0) return "[]";

  // Check if items are short strings
  const allShortStrings = arr.every(item => typeof item === "string" && item.length < 80);

  if (allShortStrings && arr.length <= 3) {
    return `[${arr.map(s => `"${s}"`).join(", ")}]`;
  }

  // Preview first 3 items
  const previews = arr.slice(0, 3).map(item => {
    if (typeof item === "string") return item.length < 60 ? `"${item}"` : `"${item.slice(0, 50)}..."`;
    if (typeof item === "object" && item !== null) {
      const keys = Object.keys(item);
      const label = item.name || item.title || item.id || keys[0];
      return `{${label}}`;
    }
    return String(item);
  });

  if (arr.length <= 3) return `[${previews.join(", ")}]`;
  return `[${previews.join(", ")}, ... +${arr.length - 3} more]`;
}

// ============================================
// GENERAL KNOWLEDGE HELPERS
// ============================================

async function listGeneralKnowledge(): Promise<string[]> {
  try {
    const files = await fs.readdir(GENERAL_KNOWLEDGE_DIR);
    return files.filter(f => f.endsWith(".json") || f.endsWith(".md"));
  } catch {
    return [];
  }
}

async function readGeneralKnowledgeRaw(filename: string): Promise<string | null> {
  try {
    return await fs.readFile(join(GENERAL_KNOWLEDGE_DIR, filename), "utf-8");
  } catch {
    return null;
  }
}

function parseKnowledgeDoc(raw: string): Record<string, any> | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function resolveKnowledgePath(filename: string, personaSlug?: string): string {
  if (personaSlug) {
    return join(PERSONAS_DIR, personaSlug, "knowledge", filename);
  }
  return join(GENERAL_KNOWLEDGE_DIR, filename);
}

// ============================================
// KNOWLEDGE HANDLER
// ============================================

export async function handleKnowledge(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "knowledge.save": {
      const title = args.title;
      const content = args.content;
      if (!title) return { success: false, output: "", error: "title is required" };
      if (!content) return { success: false, output: "", error: "content is required" };

      // Parse content as JSON — the LLM provides a structured knowledge object
      let knowledgeObj: Record<string, any>;
      if (typeof content === "string") {
        try {
          knowledgeObj = JSON.parse(content);
        } catch {
          return { success: false, output: "", error: "content must be a valid JSON string representing the structured knowledge object. Example: {\"overview\": \"...\", \"api\": [...], \"gotchas\": [...]}" };
        }
      } else if (typeof content === "object" && content !== null) {
        knowledgeObj = content;
      } else {
        return { success: false, output: "", error: "content must be a JSON object" };
      }

      // Build the full document with _meta
      const tags = args.tags
        ? args.tags.split(",").map((t: string) => t.trim()).filter(Boolean)
        : [];

      const doc: Record<string, any> = {
        _meta: {
          title,
          description: args.description || "",
          tags,
          source_url: args.source_url || "",
          source_type: args.source_type || "manual",
          captured_at: new Date().toISOString(),
        },
        ...knowledgeObj,
      };

      const filename = slugify(title) + ".json";
      const fileContent = JSON.stringify(doc, null, 2);

      const personaSlug = args.persona_slug;
      if (personaSlug) {
        const persona = await getPersona(personaSlug);
        if (!persona) {
          return { success: false, output: "", error: `Persona not found: ${personaSlug}. Create it first with personas.create.` };
        }
        await addPersonaKnowledge(personaSlug, filename, fileContent);
        const skeleton = buildKnowledgeSkeleton(doc);
        return {
          success: true,
          output: `Saved knowledge "${title}" to persona ${personaSlug}\nFile: ${filename}\n\nSkeleton:\n${skeleton}`,
        };
      } else {
        await ensureDir(GENERAL_KNOWLEDGE_DIR);
        await fs.writeFile(join(GENERAL_KNOWLEDGE_DIR, filename), fileContent, "utf-8");
        const skeleton = buildKnowledgeSkeleton(doc);
        return {
          success: true,
          output: `Saved knowledge "${title}" to general knowledge\nFile: ${filename}\n\nSkeleton:\n${skeleton}`,
        };
      }
    }

    case "knowledge.list": {
      const personaSlug = args.persona_slug;
      let files: string[];

      if (personaSlug) {
        const persona = await getPersona(personaSlug);
        if (!persona) {
          return { success: false, output: "", error: `Persona not found: ${personaSlug}` };
        }
        files = await listPersonaKnowledge(personaSlug);
      } else {
        files = await listGeneralKnowledge();
      }

      if (files.length === 0) {
        const location = personaSlug ? `persona ${personaSlug}` : "general knowledge";
        return { success: true, output: `No knowledge documents found in ${location}.` };
      }

      // Build skeletons for each document
      const entries: string[] = [];
      for (const filename of files) {
        let raw: string | null;
        if (personaSlug) {
          raw = await getPersonaKnowledge(personaSlug, filename);
        } else {
          raw = await readGeneralKnowledgeRaw(filename);
        }

        if (raw && filename.endsWith(".json")) {
          const doc = parseKnowledgeDoc(raw);
          if (doc) {
            entries.push(`--- ${filename} ---\n${buildKnowledgeSkeleton(doc)}`);
          } else {
            entries.push(`--- ${filename} --- (parse error)`);
          }
        } else if (raw) {
          // Legacy .md file — show filename only
          entries.push(`--- ${filename} --- (legacy markdown format)`);
        } else {
          entries.push(`--- ${filename} --- (unreadable)`);
        }
      }

      const location = personaSlug ? `persona "${personaSlug}"` : "general";
      return {
        success: true,
        output: `${files.length} knowledge doc(s) in ${location} knowledge:\n\n${entries.join("\n\n")}`,
      };
    }

    case "knowledge.read": {
      const filename = args.filename;
      if (!filename) return { success: false, output: "", error: "filename is required" };

      const personaSlug = args.persona_slug;
      let raw: string | null;

      if (personaSlug) {
        raw = await getPersonaKnowledge(personaSlug, filename);
      } else {
        raw = await readGeneralKnowledgeRaw(filename);
      }

      if (!raw) {
        const location = personaSlug ? `persona ${personaSlug}` : "general knowledge";
        return { success: false, output: "", error: `Knowledge document "${filename}" not found in ${location}` };
      }

      // Section-level retrieval for JSON docs
      const section = args.section;
      if (section && filename.endsWith(".json")) {
        const doc = parseKnowledgeDoc(raw);
        if (!doc) return { success: false, output: "", error: "Failed to parse knowledge document" };

        // Support dot-notation for nested keys: "api.endpoints"
        const keys = section.split(".");
        let current: any = doc;
        for (const key of keys) {
          if (current && typeof current === "object" && key in current) {
            current = current[key];
          } else {
            return {
              success: false,
              output: "",
              error: `Section "${section}" not found. Available keys: ${Object.keys(doc).filter(k => k !== "_meta").join(", ")}`,
            };
          }
        }

        return {
          success: true,
          output: typeof current === "string" ? current : JSON.stringify(current, null, 2),
        };
      }

      // Return full document
      return { success: true, output: raw };
    }

    case "knowledge.search": {
      const query = args.query;
      if (!query) return { success: false, output: "", error: "query is required" };

      const personaSlug = args.persona_slug;
      const queryLower = query.toLowerCase();

      let files: string[];
      if (personaSlug) {
        files = await listPersonaKnowledge(personaSlug);
      } else {
        files = await listGeneralKnowledge();
      }

      const matches: string[] = [];

      for (const filename of files) {
        let raw: string | null;
        if (personaSlug) {
          raw = await getPersonaKnowledge(personaSlug, filename);
        } else {
          raw = await readGeneralKnowledgeRaw(filename);
        }

        if (!raw) continue;

        if (filename.endsWith(".json")) {
          const doc = parseKnowledgeDoc(raw);
          if (!doc) continue;

          const title = doc._meta?.title || filename;
          const matchingKeys = findMatchingKeys(doc, queryLower);
          if (matchingKeys.length > 0) {
            const sections = matchingKeys.map(m => `  ${m.path}: ${truncateString(String(m.preview))}`).join("\n");
            matches.push(`${title} (${filename}):\n${sections}`);
          }
        } else {
          // Legacy .md — simple text search
          if (raw.toLowerCase().includes(queryLower)) {
            matches.push(`${filename}: (legacy md, contains match)`);
          }
        }
      }

      if (matches.length === 0) {
        return { success: true, output: `No matches found for "${query}".` };
      }

      const location = personaSlug ? `persona "${personaSlug}"` : "general";
      return {
        success: true,
        output: `Search results for "${query}" in ${location} knowledge:\n\n${matches.join("\n\n")}`,
      };
    }

    case "knowledge.delete": {
      const filename = args.filename;
      if (!filename) return { success: false, output: "", error: "filename is required" };

      const personaSlug = args.persona_slug;
      const filePath = resolveKnowledgePath(filename, personaSlug);

      try {
        await fs.unlink(filePath);
        const location = personaSlug ? `persona ${personaSlug}` : "general knowledge";
        return { success: true, output: `Deleted "${filename}" from ${location}` };
      } catch {
        return { success: false, output: "", error: `File not found: ${filePath}` };
      }
    }

    default:
      return { success: false, output: "", error: `Unknown knowledge tool: ${toolId}` };
  }
}

/**
 * Recursively search a knowledge JSON for keys/values matching a query.
 * Returns paths and preview text for matching entries.
 */
function findMatchingKeys(
  obj: Record<string, any>,
  queryLower: string,
  prefix = ""
): { path: string; preview: string }[] {
  const results: { path: string; preview: string }[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (key === "_meta") continue;
    const path = prefix ? `${prefix}.${key}` : key;

    // Match key name
    if (key.toLowerCase().includes(queryLower)) {
      results.push({ path, preview: summarizeValue(value) });
      continue;
    }

    // Match string value
    if (typeof value === "string" && value.toLowerCase().includes(queryLower)) {
      results.push({ path, preview: value });
      continue;
    }

    // Match array items
    if (Array.isArray(value)) {
      const matchingItems = value.filter(item => {
        if (typeof item === "string") return item.toLowerCase().includes(queryLower);
        if (typeof item === "object" && item !== null) return JSON.stringify(item).toLowerCase().includes(queryLower);
        return false;
      });
      if (matchingItems.length > 0) {
        results.push({ path, preview: `${matchingItems.length} matching item(s) in array of ${value.length}` });
        continue;
      }
    }

    // Recurse into objects
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      results.push(...findMatchingKeys(value, queryLower, path));
    }
  }

  return results;
}

function summarizeValue(value: any): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (typeof value === "object" && value !== null) return `{${Object.keys(value).length} keys}`;
  return String(value);
}
