/**
 * Mental Model & Schema Operations
 * 
 * CRUD for mental models, beliefs, open loops, questions,
 * constraints, schemas, and model search.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { nanoid } from "nanoid";
import type {
  MentalModel,
  MentalModelIndexEntry,
  ModelSchema,
  SchemaIndexEntry,
  Belief,
  Evidence,
  OpenLoop,
  ModelQuestion,
  Constraint
} from "./types.js";
import {
  SCHEMAS_DIR,
  MODELS_DIR,
  DEEP_MEMORY_DIR,
  fileExists,
  readJson,
  writeJson,
  slugify,
  getMemoryIndex,
  updateMemoryIndex,
  extractKeywords,
  rebuildMemoryIndex,
} from "./store-core.js";

// ============================================
// SCHEMA OPERATIONS
// ============================================

export async function getSchema(category: string): Promise<ModelSchema | null> {
  const schemaPath = path.join(SCHEMAS_DIR, `${category}.json`);
  if (!await fileExists(schemaPath)) return null;
  return readJson<ModelSchema>(schemaPath);
}

export async function saveSchema(schema: ModelSchema): Promise<void> {
  const schemaPath = path.join(SCHEMAS_DIR, `${schema.category}.json`);
  schema.lastUpdatedAt = new Date().toISOString();
  await writeJson(schemaPath, schema);

  await updateMemoryIndex(index => {
    const existingIdx = index.schemas.findIndex(s => s.category === schema.category);
    const entry: SchemaIndexEntry = {
      category: schema.category,
      description: schema.description,
      fieldCount: schema.fields.length,
      version: schema.version,
      lastUpdatedAt: schema.lastUpdatedAt
    };
    if (existingIdx >= 0) {
      index.schemas[existingIdx] = entry;
    } else {
      index.schemas.push(entry);
    }
  });
}

export async function addFieldToSchema(
  category: string,
  field: Omit<import("./types.js").SchemaField, "addedAt">
): Promise<ModelSchema | null> {
  const schema = await getSchema(category);
  if (!schema) return null;

  const fullField = {
    ...field,
    addedAt: new Date().toISOString()
  };
  
  schema.fields.push(fullField);
  schema.version++;
  await saveSchema(schema);
  return schema;
}

// ============================================
// MENTAL MODEL CRUD
// ============================================

export async function getMentalModel(slug: string): Promise<MentalModel | null> {
  const modelPath = path.join(MODELS_DIR, `${slug}.json`);
  if (!await fileExists(modelPath)) return null;
  return readJson<MentalModel>(modelPath);
}

export async function getAllMentalModels(): Promise<MentalModel[]> {
  const index = await getMemoryIndex();
  const models: MentalModel[] = [];
  for (const entry of index.models) {
    const model = await getMentalModel(entry.slug);
    if (model) models.push(model);
  }
  return models;
}

export async function saveMentalModel(model: MentalModel): Promise<void> {
  const modelPath = path.join(MODELS_DIR, `${model.slug}.json`);
  model.lastUpdatedAt = new Date().toISOString();
  await writeJson(modelPath, model);

  await updateMemoryIndex(index => {
    const existingIdx = index.models.findIndex(m => m.slug === model.slug);
    const entry: MentalModelIndexEntry = {
      slug: model.slug,
      name: model.name,
      description: model.description,
      category: model.category,
      keywords: extractKeywords(model),
      createdAt: model.createdAt,
      lastUpdatedAt: model.lastUpdatedAt,
      beliefCount: model.beliefs.length,
      openLoopCount: model.openLoops.filter(l => l.status === "open").length
    };
    if (existingIdx >= 0) {
      index.models[existingIdx] = entry;
    } else {
      index.models.push(entry);
    }
  });
}

export async function createMentalModel(
  name: string,
  category: string,
  description: string
): Promise<MentalModel> {
  const slug = slugify(name);
  const now = new Date().toISOString();
  
  const model: MentalModel = {
    slug,
    name,
    description,
    category,
    beliefs: [],
    openLoops: [],
    resolvedIssues: [],
    questions: [],
    constraints: [],
    relationships: [],
    conversations: [],
    createdAt: now,
    lastUpdatedAt: now,
    accessCount: 0
  };

  await saveMentalModel(model);
  return model;
}

export async function deleteMentalModel(slug: string): Promise<boolean> {
  const modelPath = path.join(MODELS_DIR, `${slug}.json`);
  if (!await fileExists(modelPath)) return false;
  
  await fs.unlink(modelPath);
  
  await updateMemoryIndex(index => {
    index.models = index.models.filter(m => m.slug !== slug);
  });
  
  return true;
}

// ============================================
// BELIEF OPERATIONS
// ============================================

export async function addBelief(
  modelSlug: string,
  attribute: string,
  value: any,
  evidence: Omit<Evidence, "timestamp">,
  confidence: number = 0.7
): Promise<Belief | null> {
  const model = await getMentalModel(modelSlug);
  if (!model) return null;

  const existingIdx = model.beliefs.findIndex(b => b.attribute === attribute);
  
  if (existingIdx >= 0) {
    const existing = model.beliefs[existingIdx];
    existing.value = value;
    existing.confidence = Math.min(1, confidence);
    existing.evidence.push({
      ...evidence,
      timestamp: new Date().toISOString()
    });
    existing.lastConfirmedAt = new Date().toISOString();
    await saveMentalModel(model);
    return existing;
  }

  const belief: Belief = {
    id: `belief_${nanoid(12)}`,
    attribute,
    value,
    confidence: Math.min(1, confidence),
    evidence: [{
      ...evidence,
      timestamp: new Date().toISOString()
    }],
    formedAt: new Date().toISOString(),
    lastConfirmedAt: new Date().toISOString()
  };

  model.beliefs.push(belief);
  await saveMentalModel(model);
  return belief;
}

// ============================================
// OPEN LOOP OPERATIONS
// ============================================

export async function addOpenLoop(
  modelSlug: string,
  description: string,
  importance: "high" | "medium" | "low",
  resolutionCriteria?: string
): Promise<OpenLoop | null> {
  const model = await getMentalModel(modelSlug);
  if (!model) return null;

  const loop: OpenLoop = {
    id: `loop_${nanoid(12)}`,
    description,
    importance,
    status: "open",
    identifiedAt: new Date().toISOString(),
    resolutionCriteria: resolutionCriteria || ""
  };

  model.openLoops.push(loop);
  await saveMentalModel(model);
  return loop;
}

export async function resolveOpenLoop(
  modelSlug: string,
  loopId: string,
  resolution: string
): Promise<boolean> {
  const model = await getMentalModel(modelSlug);
  if (!model) return false;

  const idx = model.openLoops.findIndex(l => l.id === loopId);
  if (idx < 0) return false;

  const loop = model.openLoops.splice(idx, 1)[0];

  // Collapse to lightweight summary
  model.resolvedIssues = model.resolvedIssues || [];
  model.resolvedIssues.push({
    summary: loop.description,
    resolution,
    resolvedAt: new Date().toISOString(),
  });

  await saveMentalModel(model);
  return true;
}

// ============================================
// QUESTION & CONSTRAINT OPERATIONS
// ============================================

export async function addQuestion(
  modelSlug: string,
  question: string,
  purpose: string,
  priority: "high" | "medium" | "low",
  informs?: string[]
): Promise<ModelQuestion | null> {
  const model = await getMentalModel(modelSlug);
  if (!model) return null;

  const q: ModelQuestion = {
    id: `q_${nanoid(12)}`,
    question,
    purpose: purpose || "",
    priority,
    informs: informs || [],
    generatedAt: new Date().toISOString()
  };

  model.questions.push(q);
  await saveMentalModel(model);
  return q;
}

export async function addConstraint(
  modelSlug: string,
  description: string,
  type: "hard" | "soft",
  source: string,
  flexibility?: "low" | "medium" | "high",
  expiresAt?: string
): Promise<Constraint | null> {
  const model = await getMentalModel(modelSlug);
  if (!model) return null;

  const constraint: Constraint = {
    id: `constraint_${nanoid(12)}`,
    description,
    type,
    source,
    flexibility: flexibility || (type === "hard" ? "low" : "medium"),
    identifiedAt: new Date().toISOString(),
    active: true,
    expiresAt,
  };

  model.constraints.push(constraint);
  await saveMentalModel(model);
  return constraint;
}

// ============================================
// SEARCH
// ============================================

export interface ScoredModelEntry extends MentalModelIndexEntry {
  source: "hot" | "deep";
}

/**
 * Score a model index entry against a search query.
 * Shared by searchMentalModels and searchAndPromote.
 */
function scoreModelEntry(entry: MentalModelIndexEntry, queryLower: string, queryWords: string[]): number {
  let score = 0;
  if (entry.name.toLowerCase().includes(queryLower)) score += 10;
  if (entry.description.toLowerCase().includes(queryLower)) score += 5;
  for (const word of queryWords) {
    if (entry.keywords.some(k => k.includes(word))) score += 2;
  }
  if (entry.category.includes(queryLower)) score += 3;
  return score;
}

export async function searchMentalModels(query: string, includeDeep = true): Promise<ScoredModelEntry[]> {
  const index = await getMemoryIndex();
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

  // Score hot models
  const results: { entry: ScoredModelEntry; score: number }[] = index.models
    .map(model => ({
      entry: { ...model, source: "hot" as const },
      score: scoreModelEntry(model, queryLower, queryWords),
    }))
    .filter(r => r.score > 0);

  // Score deep memory models
  if (includeDeep) {
    const deepEntries = await getDeepMemoryIndex();
    for (const entry of deepEntries) {
      const score = scoreModelEntry(entry, queryLower, queryWords);
      if (score > 0) {
        results.push({ entry: { ...entry, source: "deep" }, score });
      }
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .map(r => r.entry);
}

// ============================================
// DEEP MEMORY (cold storage search + promotion)
// ============================================

/**
 * Scan deep memory directory and build index entries for search.
 * Does NOT load full models — just reads enough for scoring.
 */
export async function getDeepMemoryIndex(): Promise<MentalModelIndexEntry[]> {
  try {
    const files = await fs.readdir(DEEP_MEMORY_DIR);
    const entries: MentalModelIndexEntry[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const model = await readJson<MentalModel>(path.join(DEEP_MEMORY_DIR, file));
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
      } catch (err) {
        console.warn(`[Memory] Skipping corrupt deep memory file: ${file}`, err instanceof Error ? err.message : err);
      }
    }

    return entries;
  } catch {
    return []; // deep/ directory doesn't exist yet
  }
}

/**
 * Get a mental model from deep memory.
 */
export async function getDeepModel(slug: string): Promise<MentalModel | null> {
  const modelPath = path.join(DEEP_MEMORY_DIR, `${slug}.json`);
  if (!await fileExists(modelPath)) return null;
  return readJson<MentalModel>(modelPath);
}

/**
 * Promote a model from deep memory back to hot (active) memory.
 * Moves the file from deep/ → models/ and rebuilds the index.
 */
export async function promoteModel(slug: string): Promise<boolean> {
  const src = path.join(DEEP_MEMORY_DIR, `${slug}.json`);
  const dest = path.join(MODELS_DIR, `${slug}.json`);

  if (!await fileExists(src)) return false;

  try {
    await fs.rename(src, dest);
    await rebuildMemoryIndex();
    console.log(`[Memory] Promoted model "${slug}" from deep → hot memory`);
    return true;
  } catch (err) {
    console.error(`[Memory] Failed to promote model "${slug}":`, err);
    return false;
  }
}

/**
 * Search deep memory and auto-promote models that match well.
 * Returns promoted slugs.
 */
export async function searchAndPromote(query: string, promoteThreshold = 8): Promise<string[]> {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);
  const deepEntries = await getDeepMemoryIndex();
  const promoted: string[] = [];

  for (const entry of deepEntries) {
    const score = scoreModelEntry(entry, queryLower, queryWords);
    if (score >= promoteThreshold) {
      const success = await promoteModel(entry.slug);
      if (success) promoted.push(entry.slug);
    }
  }

  return promoted;
}

// ============================================
// MODEL SKELETON (compact structure for context injection)
// ============================================

/**
 * Build a compact skeleton of a mental model for context injection.
 * Shows the model's structure without full content — the LLM can then
 * request specific sections via tools if it needs more detail.
 *
 * Format:
 *   Name (category) — description
 *   Beliefs: attribute: value (confidence) per line
 *   Open Loops: short descriptions
 *   Relationships: → target (type)
 *   Constraints: short descriptions
 *   Questions: short descriptions
 *
 * Truncation rules (same philosophy as buildKnowledgeSkeleton):
 *   - String values <100 chars → inline
 *   - String values ≥100 chars → first 80 chars + "..."
 *   - Arrays ≤3 short items → inline
 *   - Arrays >3 items → first 3 + count
 *   - Objects → show keys only
 */
export function buildModelSkeleton(model: MentalModel): string {
  const lines: string[] = [];

  // Header
  lines.push(`**${model.name}** (${model.category}) — ${model.description || "no description"}`);

  // Beliefs — the core content
  const activeBeliefs = model.beliefs.filter(b => !b.contradicted);
  if (activeBeliefs.length > 0) {
    lines.push(`  Beliefs (${activeBeliefs.length}):`);
    for (const b of activeBeliefs) {
      const conf = b.confidence < 1 ? ` [${Math.round(b.confidence * 100)}%]` : "";
      const val = formatSkeletonValue(b.value);
      lines.push(`    ${b.attribute}: ${val}${conf}`);
    }
  }

  // Open loops — unresolved items
  const openLoops = (model.openLoops || []).filter(l => l.status === "open" || l.status === "investigating");
  if (openLoops.length > 0) {
    lines.push(`  Open loops (${openLoops.length}):`);
    for (const l of openLoops) {
      const status = l.status === "investigating" ? " [investigating]" : "";
      lines.push(`    - ${truncSkel(l.description, 100)}${status}`);
    }
  }

  // Relationships
  if (model.relationships && model.relationships.length > 0) {
    lines.push(`  Relationships (${model.relationships.length}):`);
    for (const r of model.relationships) {
      const arrow = r.direction === "incoming" ? "←" : r.direction === "bidirectional" ? "↔" : "→";
      lines.push(`    ${arrow} ${r.targetSlug} (${r.type})`);
    }
  }

  // Constraints (summary only)
  const activeConstraints = (model.constraints || []).filter(c => c.active);
  if (activeConstraints.length > 0) {
    lines.push(`  Constraints (${activeConstraints.length}):`);
    for (const c of activeConstraints) {
      lines.push(`    - [${c.type}] ${truncSkel(c.description, 80)}`);
    }
  }

  // Questions (summary only)
  const unanswered = (model.questions || []).filter(q => !q.asked?.answer);
  if (unanswered.length > 0) {
    lines.push(`  Unanswered questions (${unanswered.length}):`);
    for (const q of unanswered.slice(0, 3)) {
      lines.push(`    - ${truncSkel(q.question, 80)}`);
    }
    if (unanswered.length > 3) {
      lines.push(`    ... +${unanswered.length - 3} more`);
    }
  }

  return lines.join("\n");
}

/**
 * Build skeletons for multiple models by slug.
 * Returns a map of slug → skeleton string.
 */
export async function getModelSkeletons(slugs: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const slug of slugs) {
    const model = await getMentalModel(slug) || await getDeepModel(slug);
    if (model) {
      result[slug] = buildModelSkeleton(model);
    }
  }
  return result;
}

function formatSkeletonValue(value: any): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return truncSkel(value, 100);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const allShort = value.every(v => typeof v === "string" && v.length < 60);
    if (allShort && value.length <= 3) return `[${value.join(", ")}]`;
    if (value.length <= 3) return `[${value.map(v => typeof v === "string" ? truncSkel(v, 50) : typeof v === "object" ? "{...}" : String(v)).join(", ")}]`;
    const preview = value.slice(0, 3).map(v => typeof v === "string" ? truncSkel(v, 40) : String(v)).join(", ");
    return `[${preview}, ... +${value.length - 3} more]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length <= 3) return `{${keys.join(", ")}}`;
    return `{${keys.slice(0, 3).join(", ")}, ... +${keys.length - 3} more}`;
  }
  return String(value);
}

function truncSkel(s: string, max: number): string {
  const clean = String(s).replace(/\n/g, " ").trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 3) + "...";
}

// ============================================
// MERGE OPERATIONS
// ============================================

export interface MergeResult {
  merged: MentalModel;
  repointed: number;
  absorbedSlug: string;
}

/**
 * Merge two mental models. The `keepSlug` model absorbs the `absorbSlug` model.
 * 
 * - Beliefs: union by attribute. On conflict, keep highest confidence, append evidence.
 * - Open loops: union. Skip exact description duplicates.
 * - Relationships: union by targetSlug+type. On conflict, keep highest confidence.
 * - Constraints: union by description. Skip exact duplicates.
 * - Questions: union. Skip exact question duplicates.
 * - Conversations: concat, sort by timestamp, cap at 50.
 * - Resolved issues: concat.
 * - Access count: sum.
 * - Created at: keep earliest.
 * 
 * After absorbing, repoints all OTHER models that have relationships pointing
 * at the absorbed model to point at the kept model instead. Then deletes the
 * absorbed model and rebuilds the index.
 */
export async function mergeMentalModels(
  keepSlug: string,
  absorbSlug: string
): Promise<MergeResult | null> {
  const keep = await getMentalModel(keepSlug) || await getDeepModel(keepSlug);
  const absorb = await getMentalModel(absorbSlug) || await getDeepModel(absorbSlug);

  if (!keep || !absorb) return null;
  if (keepSlug === absorbSlug) return null;

  // ── Beliefs: dedupe by attribute, keep highest confidence ──
  for (const ab of absorb.beliefs) {
    const existing = keep.beliefs.find(b => b.attribute === ab.attribute);
    if (existing) {
      if (ab.confidence > existing.confidence) {
        existing.value = ab.value;
        existing.confidence = ab.confidence;
      }
      existing.evidence.push(...(ab.evidence || []));
      if (ab.lastConfirmedAt > existing.lastConfirmedAt) {
        existing.lastConfirmedAt = ab.lastConfirmedAt;
      }
    } else {
      keep.beliefs.push(ab);
    }
  }

  // ── Open loops: skip exact description duplicates ──
  for (const al of absorb.openLoops) {
    const dup = keep.openLoops.some(l => l.description === al.description);
    if (!dup) keep.openLoops.push(al);
  }

  // ── Relationships: dedupe by targetSlug + type ──
  for (const ar of absorb.relationships) {
    // Skip self-referencing relationships (absorb pointing to keep or vice versa)
    if (ar.targetSlug === keepSlug) continue;
    const existing = keep.relationships.find(
      r => r.targetSlug === ar.targetSlug && r.type === ar.type
    );
    if (existing) {
      existing.confidence = Math.max(existing.confidence, ar.confidence);
      existing.context = ar.context || existing.context;
    } else {
      keep.relationships.push(ar);
    }
  }

  // ── Constraints: skip exact description duplicates ──
  for (const ac of absorb.constraints || []) {
    const dup = (keep.constraints || []).some(c => c.description === ac.description);
    if (!dup) {
      keep.constraints = keep.constraints || [];
      keep.constraints.push(ac);
    }
  }

  // ── Questions: skip exact question duplicates ──
  for (const aq of absorb.questions || []) {
    const dup = (keep.questions || []).some(q => q.question === aq.question);
    if (!dup) {
      keep.questions = keep.questions || [];
      keep.questions.push(aq);
    }
  }

  // ── Conversations: concat, sort, cap ──
  keep.conversations = [...keep.conversations, ...(absorb.conversations || [])];
  keep.conversations.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
  if (keep.conversations.length > 50) {
    keep.conversations = keep.conversations.slice(-50);
  }

  // ── Resolved issues: concat ──
  keep.resolvedIssues = [...(keep.resolvedIssues || []), ...(absorb.resolvedIssues || [])];

  // ── Scalar fields ──
  keep.accessCount = (keep.accessCount || 0) + (absorb.accessCount || 0);
  if (absorb.createdAt < keep.createdAt) {
    keep.createdAt = absorb.createdAt;
  }
  keep.lastUpdatedAt = new Date().toISOString();

  // ── Repoint relationships in ALL other models ──
  let repointed = 0;
  const allModels = await getAllMentalModels();
  for (const model of allModels) {
    if (model.slug === keepSlug || model.slug === absorbSlug) continue;
    let changed = false;
    for (const rel of model.relationships) {
      if (rel.targetSlug === absorbSlug) {
        // Check if this would create a duplicate (already has a relationship to keepSlug with same type)
        const existing = model.relationships.find(
          r => r.targetSlug === keepSlug && r.type === rel.type
        );
        if (existing) {
          existing.confidence = Math.max(existing.confidence, rel.confidence);
          // Mark for removal by setting targetSlug to empty (cleaned below)
          rel.targetSlug = "";
        } else {
          rel.targetSlug = keepSlug;
        }
        changed = true;
        repointed++;
      }
    }
    if (changed) {
      // Remove any relationships that were marked empty (duplicates)
      model.relationships = model.relationships.filter(r => r.targetSlug !== "");
      model.lastUpdatedAt = new Date().toISOString();
      await saveMentalModel(model);
    }
  }

  // ── Save the merged model and delete the absorbed one ──
  await saveMentalModel(keep);
  await deleteMentalModel(absorbSlug);

  // Also try to delete from deep memory if it was demoted
  const deepPath = path.join(DEEP_MEMORY_DIR, `${absorbSlug}.json`);
  try { await fs.unlink(deepPath); } catch { /* not in deep — fine */ }

  await rebuildMemoryIndex();

  return { merged: keep, repointed, absorbedSlug: absorbSlug };
}
