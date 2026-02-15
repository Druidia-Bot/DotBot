/**
 * Memory Store Core
 * 
 * Shared utilities, paths, initialization, index management, and default schemas.
 * All other store-* modules import from here.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { homedir } from "os";
import type {
  MentalModel,
  MentalModelIndexEntry,
  MemoryIndex,
  ModelSchema,
  SchemaIndexEntry,
} from "./types.js";

// ============================================
// PATH UTILITIES
// ============================================

export const DOTBOT_DIR = path.join(homedir(), ".bot");
export const MEMORY_DIR = path.join(DOTBOT_DIR, "memory");
export const SCHEMAS_DIR = path.join(MEMORY_DIR, "schemas");
export const MODELS_DIR = path.join(MEMORY_DIR, "models");
export const DEEP_MEMORY_DIR = path.join(MEMORY_DIR, "deep");
export const SKILLS_DIR = path.join(DOTBOT_DIR, "skills");
export const THREADS_DIR = path.join(MEMORY_DIR, "threads");
export const ARCHIVE_DIR = path.join(MEMORY_DIR, "threads", "archive");
export const AGENT_WORK_DIR = path.join(THREADS_DIR, "agent-work");
export const TEMP_DIR = process.env.DOTBOT_TEMP_DIR || path.join(DOTBOT_DIR, "temp");

export const MEMORY_INDEX_PATH = path.join(MEMORY_DIR, "index.json");

// ============================================
// FILE UTILITIES
// ============================================

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, "utf-8");
  try {
    return JSON.parse(content);
  } catch (err) {
    // If the file is corrupted, back it up and throw so callers can handle it
    const backupPath = filePath + `.corrupt_${Date.now()}`;
    console.error(`[Memory] Corrupt JSON in ${filePath}, backing up to ${backupPath}`);
    await fs.copyFile(filePath, backupPath).catch(() => {});
    throw new Error(`Corrupt JSON in ${filePath}: ${err instanceof Error ? err.message : err}`);
  }
}

export async function writeJson(filePath: string, data: any): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  // Atomic write: write to temp file, then rename.
  // rename() is atomic on the same filesystem, preventing partial-write corruption.
  const tmpPath = filePath + `.tmp_${Date.now()}`;
  await fs.writeFile(tmpPath, json, "utf-8");
  // AGENT-08: Retry rename on Windows — NTFS can fail with EPERM if target is locked
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fs.rename(tmpPath, filePath);
      return;
    } catch (err: any) {
      if (err.code === "EPERM" && attempt < 2) {
        await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
        continue;
      }
      // Final attempt failed — clean up temp file and fall back to direct write
      try { await fs.unlink(tmpPath); } catch {}
      if (err.code === "EPERM") {
        await fs.writeFile(filePath, json, "utf-8");
        return;
      }
      throw err;
    }
  }
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ============================================
// INITIALIZATION
// ============================================

export async function initializeMemoryStore(): Promise<void> {
  await fs.mkdir(SCHEMAS_DIR, { recursive: true });
  await fs.mkdir(MODELS_DIR, { recursive: true });
  await fs.mkdir(SKILLS_DIR, { recursive: true });
  await fs.mkdir(TEMP_DIR, { recursive: true });
  await cleanupTempDir();

  if (!await fileExists(MEMORY_INDEX_PATH)) {
    const initialIndex: MemoryIndex = {
      version: "1.0",
      lastUpdatedAt: new Date().toISOString(),
      models: [],
      schemas: []
    };
    await writeJson(MEMORY_INDEX_PATH, initialIndex);
  }

  // Rebuild index from disk so it's always in sync with model files
  await rebuildMemoryIndex();

  await ensureDefaultSchemas();
}

const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function cleanupTempDir(): Promise<number> {
  let cleaned = 0;
  try {
    const now = Date.now();
    const entries = await fs.readdir(TEMP_DIR, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(TEMP_DIR, entry.name);
      try {
        const stat = await fs.stat(fullPath);
        if (now - stat.mtimeMs > TEMP_MAX_AGE_MS) {
          if (entry.isDirectory()) {
            await fs.rm(fullPath, { recursive: true, force: true });
          } else {
            await fs.unlink(fullPath);
          }
          cleaned++;
        }
      } catch {
        // Skip entries we can't stat or delete
      }
    }
    if (cleaned > 0) {
      console.log(`[Temp] Cleaned ${cleaned} stale item(s) from ${TEMP_DIR}`);
    }
  } catch {
    // TEMP_DIR doesn't exist yet or is empty — fine
  }
  return cleaned;
}

// ============================================
// INDEX OPERATIONS
// ============================================

export async function getMemoryIndex(): Promise<MemoryIndex> {
  const raw = await readJson<MemoryIndex>(MEMORY_INDEX_PATH);
  return {
    version: raw.version || "1.0",
    lastUpdatedAt: raw.lastUpdatedAt || new Date().toISOString(),
    models: raw.models || [],
    schemas: raw.schemas || [],
  };
}

export async function updateMemoryIndex(updater: (index: MemoryIndex) => void): Promise<void> {
  const index = await getMemoryIndex();
  updater(index);
  index.lastUpdatedAt = new Date().toISOString();
  await writeJson(MEMORY_INDEX_PATH, index);
}

/**
 * Rebuild the memory index by scanning all model files in models/.
 * Called after batch instruction application to ensure index is consistent.
 * 
 * Only models in models/ are indexed. Demoted models live in deep/ and
 * are not scanned — they can be promoted back in the future.
 */
export async function rebuildMemoryIndex(): Promise<void> {
  await fs.mkdir(MODELS_DIR, { recursive: true });
  const files = await fs.readdir(MODELS_DIR);
  const entries: MentalModelIndexEntry[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const model = await readJson<MentalModel>(path.join(MODELS_DIR, file));
      entries.push({
        slug: model.slug,
        name: model.name,
        description: model.description || "",
        category: model.category,
        keywords: extractKeywords(model),
        createdAt: model.createdAt,
        lastUpdatedAt: model.lastUpdatedAt,
        beliefCount: model.beliefs?.length || 0,
        openLoopCount: (model.openLoops || []).filter(l => l.status === "open").length,
      });
    } catch { /* skip corrupt files */ }
  }

  const index = await getMemoryIndex();
  index.models = entries;
  index.lastUpdatedAt = new Date().toISOString();
  await writeJson(MEMORY_INDEX_PATH, index);
}

/**
 * Extract keywords from a mental model for L0 indexing.
 */
export function extractKeywords(model: MentalModel): string[] {
  const words = new Set<string>();
  model.name.toLowerCase().split(/\s+/).forEach(w => { if (w.length > 2) words.add(w); });
  words.add(model.category);
  for (const b of model.beliefs || []) {
    b.attribute.toLowerCase().split(/\s+/).forEach(w => { if (w.length > 2) words.add(w); });
  }
  for (const r of model.relationships || []) {
    r.targetSlug.split("-").forEach(w => { if (w.length > 2) words.add(w); });
  }
  return Array.from(words).slice(0, 20);
}

// ============================================
// DEFAULT SCHEMAS
// ============================================

const DEFAULT_SCHEMAS: ModelSchema[] = [
  {
    category: "person",
    description: "A human being - could be family, friend, colleague, etc.",
    fields: [
      { name: "relationship", type: "string", description: "How this person relates to the user", required: true, examples: ["spouse", "child", "boss", "friend"], addedAt: new Date().toISOString() },
      { name: "occupation", type: "string", description: "What they do for work/school", required: false, examples: ["teacher", "student", "engineer"], addedAt: new Date().toISOString() },
      { name: "location", type: "string", description: "Where they live or are usually located", required: false, addedAt: new Date().toISOString() },
      { name: "contactInfo", type: "object", description: "Phone, email, etc.", required: false, addedAt: new Date().toISOString() },
      { name: "schedule", type: "object", description: "Regular schedule or availability", required: false, addedAt: new Date().toISOString() },
      { name: "preferences", type: "object", description: "Known likes, dislikes, preferences", required: false, addedAt: new Date().toISOString() }
    ],
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    version: 1
  },
  {
    category: "project",
    description: "A project or initiative being worked on",
    fields: [
      { name: "status", type: "string", description: "Current status", required: true, examples: ["planning", "in-progress", "blocked", "completed"], addedAt: new Date().toISOString() },
      { name: "goal", type: "string", description: "What the project aims to achieve", required: true, addedAt: new Date().toISOString() },
      { name: "deadline", type: "date", description: "When the project should be done", required: false, addedAt: new Date().toISOString() },
      { name: "stakeholders", type: "array", description: "People involved or affected", required: false, addedAt: new Date().toISOString() },
      { name: "technologies", type: "array", description: "Tech stack or tools being used", required: false, addedAt: new Date().toISOString() },
      { name: "budget", type: "number", description: "Budget if applicable", required: false, addedAt: new Date().toISOString() }
    ],
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    version: 1
  },
  {
    category: "place",
    description: "A physical location",
    fields: [
      { name: "address", type: "string", description: "Physical address", required: false, addedAt: new Date().toISOString() },
      { name: "type", type: "string", description: "Type of place", required: true, examples: ["home", "office", "store", "restaurant"], addedAt: new Date().toISOString() },
      { name: "hours", type: "object", description: "Operating hours if applicable", required: false, addedAt: new Date().toISOString() },
      { name: "coordinates", type: "object", description: "Lat/long if known", required: false, addedAt: new Date().toISOString() }
    ],
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    version: 1
  },
  {
    category: "object",
    description: "A physical or digital object/item",
    fields: [
      { name: "type", type: "string", description: "What kind of object", required: true, addedAt: new Date().toISOString() },
      { name: "location", type: "string", description: "Where it's stored/located", required: false, addedAt: new Date().toISOString() },
      { name: "owner", type: "string", description: "Who owns it", required: false, addedAt: new Date().toISOString() },
      { name: "value", type: "number", description: "Monetary value if known", required: false, addedAt: new Date().toISOString() }
    ],
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    version: 1
  },
  {
    category: "concept",
    description: "An idea, topic, or abstract concept",
    fields: [
      { name: "domain", type: "string", description: "What field/area this concept belongs to", required: false, addedAt: new Date().toISOString() },
      { name: "definition", type: "string", description: "What this concept means", required: true, addedAt: new Date().toISOString() },
      { name: "relatedConcepts", type: "array", description: "Related ideas", required: false, addedAt: new Date().toISOString() }
    ],
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    version: 1
  },
  {
    category: "event",
    description: "Something that happened or will happen",
    fields: [
      { name: "date", type: "date", description: "When it occurs", required: true, addedAt: new Date().toISOString() },
      { name: "recurring", type: "boolean", description: "Does it repeat", required: false, addedAt: new Date().toISOString() },
      { name: "participants", type: "array", description: "Who's involved", required: false, addedAt: new Date().toISOString() },
      { name: "location", type: "string", description: "Where it happens", required: false, addedAt: new Date().toISOString() }
    ],
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    version: 1
  },
  {
    category: "organization",
    description: "A company, institution, or group",
    fields: [
      { name: "type", type: "string", description: "Type of organization", required: true, examples: ["company", "school", "government", "nonprofit"], addedAt: new Date().toISOString() },
      { name: "industry", type: "string", description: "What industry/sector", required: false, addedAt: new Date().toISOString() },
      { name: "size", type: "string", description: "Approximate size", required: false, addedAt: new Date().toISOString() },
      { name: "contacts", type: "array", description: "Known people at this org", required: false, addedAt: new Date().toISOString() }
    ],
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    version: 1
  }
];

async function ensureDefaultSchemas(): Promise<void> {
  // Import saveSchema lazily to avoid circular dependency
  const { saveSchema } = await import("./store-models.js");
  const index = await getMemoryIndex();
  
  for (const schema of DEFAULT_SCHEMAS) {
    const exists = index.schemas.some(s => s.category === schema.category);
    if (!exists) {
      await saveSchema(schema);
    }
  }
}
