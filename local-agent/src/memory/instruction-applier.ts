/**
 * Instruction Applier
 * 
 * Programmatically applies CondenserInstructions to local memory files.
 * Each instruction is an atomic operation — add/remove/update a belief,
 * close a loop, archive a thread, etc.
 * 
 * The LLM never rewrites full models. It returns instructions, we execute them.
 */

import { nanoid } from "nanoid";
import * as store from "./store.js";
import * as identity from "./store-identity.js";
import type {
  CondenserInstruction,
  MentalModel,
  Belief,
  Evidence,
  OpenLoop,
  Constraint,
  Relationship,
  ConversationReference,
} from "./types.js";

export interface ApplyResult {
  applied: number;
  skipped: number;
  errors: string[];
}

/**
 * Apply a batch of condenser instructions to local memory.
 * Returns a summary of what was applied.
 */
export async function applyInstructions(instructions: CondenserInstruction[]): Promise<ApplyResult> {
  const result: ApplyResult = { applied: 0, skipped: 0, errors: [] };

  for (const instruction of instructions) {
    try {
      const ok = await applySingle(instruction);
      if (ok) {
        result.applied++;
      } else {
        result.skipped++;
      }
    } catch (err) {
      result.errors.push(`${instruction.action}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Rebuild the memory index after applying all changes
  if (result.applied > 0) {
    try {
      await store.rebuildMemoryIndex();
    } catch {
      result.errors.push("Failed to rebuild memory index");
    }
  }

  return result;
}

async function applySingle(instruction: CondenserInstruction): Promise<boolean> {
  switch (instruction.action) {
    case "add_belief":
      return await handleAddBelief(instruction);
    case "update_belief":
      return await handleUpdateBelief(instruction);
    case "remove_belief":
      return await handleRemoveBelief(instruction);
    case "add_constraint":
      return await handleAddConstraint(instruction);
    case "remove_constraint":
      return await handleRemoveConstraint(instruction);
    case "add_open_loop":
      return await handleAddOpenLoop(instruction);
    case "close_loop":
      return await handleCloseLoop(instruction);
    case "update_loop_status":
      return await handleUpdateLoopStatus(instruction);
    case "add_relationship":
      return await handleAddRelationship(instruction);
    case "remove_relationship":
      return await handleRemoveRelationship(instruction);
    case "create_model":
      return await handleCreateModel(instruction);
    case "update_model_meta":
      return await handleUpdateModelMeta(instruction);
    case "add_conversation_ref":
      return await handleAddConversationRef(instruction);
    case "update_keywords":
      return await handleUpdateKeywords(instruction);
    case "archive_thread":
      return await handleArchiveThread(instruction);
    case "condense_thread":
      return await handleCondenseThread(instruction);
    // Identity instructions
    case "identity_add_trait":
      return await identity.addTrait(instruction.value);
    case "identity_remove_trait":
      return await identity.removeTrait(instruction.value);
    case "identity_add_ethic":
      return await identity.addEthic(instruction.value);
    case "identity_remove_ethic":
      return await identity.removeEthic(instruction.value);
    case "identity_add_conduct":
      return await identity.addConduct(instruction.value);
    case "identity_remove_conduct":
      return await identity.removeConduct(instruction.value);
    case "identity_set_property":
      return await identity.setProperty(instruction.key, instruction.value);
    case "identity_remove_property":
      return await identity.removeProperty(instruction.key);
    case "identity_add_instruction":
      return await identity.addInstruction(instruction.value);
    case "identity_remove_instruction":
      return await identity.removeInstruction(instruction.value);
    case "identity_add_communication_style":
      return await identity.addCommunicationStyle(instruction.value);
    case "identity_remove_communication_style":
      return await identity.removeCommunicationStyle(instruction.value);
    case "identity_set_name":
      return await identity.setName(instruction.value);
    case "identity_set_role":
      return await identity.setRole(instruction.value);
    default:
      return false;
  }
}

// ============================================
// BELIEF OPERATIONS
// ============================================

async function handleAddBelief(inst: Extract<CondenserInstruction, { action: "add_belief" }>): Promise<boolean> {
  const model = await store.getMentalModel(inst.modelSlug);
  if (!model) return false;

  // Check for duplicate by attribute
  const existing = model.beliefs.find(b => b.attribute === inst.belief.attribute);
  if (existing) {
    // Boost confidence on existing belief instead of duplicating
    existing.confidence = Math.min(1, existing.confidence + 0.05);
    existing.lastConfirmedAt = new Date().toISOString();
    if (inst.belief.evidence) {
      existing.evidence.push(...inst.belief.evidence);
    }
  } else {
    const belief: Belief = {
      id: inst.belief.id || `belief_${nanoid(8)}`,
      attribute: inst.belief.attribute,
      value: inst.belief.value,
      confidence: inst.belief.confidence ?? 0.9,
      evidence: inst.belief.evidence || [{
        type: "observed",
        content: "Extracted during sleep cycle condensation",
        timestamp: new Date().toISOString(),
        source: "condenser",
        strength: 0.8,
      }],
      formedAt: inst.belief.formedAt || new Date().toISOString(),
      lastConfirmedAt: inst.belief.lastConfirmedAt || new Date().toISOString(),
    };
    model.beliefs.push(belief);
  }

  model.lastUpdatedAt = new Date().toISOString();
  await store.saveMentalModel(model);
  return true;
}

async function handleUpdateBelief(inst: Extract<CondenserInstruction, { action: "update_belief" }>): Promise<boolean> {
  const model = await store.getMentalModel(inst.modelSlug);
  if (!model) return false;

  const belief = model.beliefs.find(b => b.id === inst.beliefId);
  if (!belief) return false;

  if (inst.updates.value !== undefined) belief.value = inst.updates.value;
  if (inst.updates.confidence !== undefined) belief.confidence = inst.updates.confidence;
  if (inst.updates.evidence) belief.evidence.push(inst.updates.evidence);
  belief.lastConfirmedAt = new Date().toISOString();

  model.lastUpdatedAt = new Date().toISOString();
  await store.saveMentalModel(model);
  return true;
}

async function handleRemoveBelief(inst: Extract<CondenserInstruction, { action: "remove_belief" }>): Promise<boolean> {
  const model = await store.getMentalModel(inst.modelSlug);
  if (!model) return false;

  const idx = model.beliefs.findIndex(b => b.id === inst.beliefId);
  if (idx === -1) return false;

  model.beliefs.splice(idx, 1);
  model.lastUpdatedAt = new Date().toISOString();
  await store.saveMentalModel(model);
  return true;
}

// ============================================
// CONSTRAINT OPERATIONS
// ============================================

async function handleAddConstraint(inst: Extract<CondenserInstruction, { action: "add_constraint" }>): Promise<boolean> {
  const model = await store.getMentalModel(inst.modelSlug);
  if (!model) return false;

  const constraint: Constraint = {
    ...inst.constraint,
    id: inst.constraint.id || `constraint_${nanoid(8)}`,
    active: true,
    identifiedAt: inst.constraint.identifiedAt || new Date().toISOString(),
  };
  model.constraints.push(constraint);

  model.lastUpdatedAt = new Date().toISOString();
  await store.saveMentalModel(model);
  return true;
}

async function handleRemoveConstraint(inst: Extract<CondenserInstruction, { action: "remove_constraint" }>): Promise<boolean> {
  const model = await store.getMentalModel(inst.modelSlug);
  if (!model) return false;

  const constraint = model.constraints.find(c => c.id === inst.constraintId);
  if (!constraint) return false;

  constraint.active = false;
  model.lastUpdatedAt = new Date().toISOString();
  await store.saveMentalModel(model);
  return true;
}

// ============================================
// OPEN LOOP OPERATIONS
// ============================================

async function handleAddOpenLoop(inst: Extract<CondenserInstruction, { action: "add_open_loop" }>): Promise<boolean> {
  const model = await store.getMentalModel(inst.modelSlug);
  if (!model) return false;

  const loop: OpenLoop = {
    ...inst.loop,
    id: inst.loop.id || `loop_${nanoid(8)}`,
    status: "open",
    identifiedAt: inst.loop.identifiedAt || new Date().toISOString(),
  };
  model.openLoops.push(loop);

  model.lastUpdatedAt = new Date().toISOString();
  await store.saveMentalModel(model);
  return true;
}

async function handleCloseLoop(inst: Extract<CondenserInstruction, { action: "close_loop" }>): Promise<boolean> {
  const model = await store.getMentalModel(inst.modelSlug);
  if (!model) return false;

  const idx = model.openLoops.findIndex(l => l.id === inst.loopId);
  if (idx < 0) return false;

  const loop = model.openLoops.splice(idx, 1)[0];

  // Collapse to lightweight summary instead of keeping the full object
  model.resolvedIssues = model.resolvedIssues || [];
  model.resolvedIssues.push({
    summary: loop.description,
    resolution: inst.resolution,
    resolvedAt: new Date().toISOString(),
  });

  model.lastUpdatedAt = new Date().toISOString();
  await store.saveMentalModel(model);
  return true;
}

async function handleUpdateLoopStatus(inst: Extract<CondenserInstruction, { action: "update_loop_status" }>): Promise<boolean> {
  const model = await store.getMentalModel(inst.modelSlug);
  if (!model) return false;

  const loop = model.openLoops.find(l => l.id === inst.loopId);
  if (!loop) return false;

  loop.status = inst.status;

  model.lastUpdatedAt = new Date().toISOString();
  await store.saveMentalModel(model);
  return true;
}

// ============================================
// RELATIONSHIP OPERATIONS
// ============================================

async function handleAddRelationship(inst: Extract<CondenserInstruction, { action: "add_relationship" }>): Promise<boolean> {
  const model = await store.getMentalModel(inst.modelSlug);
  if (!model) return false;

  // Avoid duplicate relationships
  const existing = model.relationships.find(
    r => r.targetSlug === inst.relationship.targetSlug && r.type === inst.relationship.type
  );
  if (existing) {
    existing.confidence = Math.max(existing.confidence, inst.relationship.confidence);
    existing.context = inst.relationship.context || existing.context;
  } else {
    model.relationships.push({
      ...inst.relationship,
      identifiedAt: inst.relationship.identifiedAt || new Date().toISOString(),
    });
  }

  model.lastUpdatedAt = new Date().toISOString();
  await store.saveMentalModel(model);
  return true;
}

async function handleRemoveRelationship(inst: Extract<CondenserInstruction, { action: "remove_relationship" }>): Promise<boolean> {
  const model = await store.getMentalModel(inst.modelSlug);
  if (!model) return false;

  const idx = model.relationships.findIndex(
    r => r.targetSlug === inst.targetSlug && r.type === inst.type
  );
  if (idx === -1) return false;

  model.relationships.splice(idx, 1);
  model.lastUpdatedAt = new Date().toISOString();
  await store.saveMentalModel(model);
  return true;
}

// ============================================
// MODEL OPERATIONS
// ============================================

async function handleCreateModel(inst: Extract<CondenserInstruction, { action: "create_model" }>): Promise<boolean> {
  // Check if model already exists
  const existing = await store.getMentalModel(inst.slug);
  if (existing) return false; // Don't overwrite

  const now = new Date().toISOString();
  const model: MentalModel = {
    slug: inst.slug,
    name: inst.name,
    category: inst.category,
    description: inst.description,
    beliefs: (inst.initialBeliefs || []).map(b => ({
      ...b,
      id: b.id || `belief_${nanoid(8)}`,
      evidence: [{
        type: "observed" as const,
        content: "Extracted during sleep cycle condensation",
        timestamp: now,
        source: "condenser",
        strength: 0.8,
      }],
    })),
    openLoops: [],
    resolvedIssues: [],
    questions: [],
    constraints: [],
    relationships: [],
    conversations: [],
    createdAt: now,
    lastUpdatedAt: now,
    accessCount: 0,
  };

  await store.saveMentalModel(model);
  return true;
}

async function handleUpdateModelMeta(inst: Extract<CondenserInstruction, { action: "update_model_meta" }>): Promise<boolean> {
  const model = await store.getMentalModel(inst.modelSlug);
  if (!model) return false;

  if (inst.updates.name) model.name = inst.updates.name;
  if (inst.updates.description) model.description = inst.updates.description;
  if (inst.updates.category) model.category = inst.updates.category;

  model.lastUpdatedAt = new Date().toISOString();
  await store.saveMentalModel(model);
  return true;
}

async function handleAddConversationRef(inst: Extract<CondenserInstruction, { action: "add_conversation_ref" }>): Promise<boolean> {
  const model = await store.getMentalModel(inst.modelSlug);
  if (!model) return false;

  const ref: ConversationReference = {
    timestamp: inst.ref.timestamp || new Date().toISOString(),
    summary: inst.ref.summary,
    keyPoints: inst.ref.keyPoints || [],
  };
  model.conversations.push(ref);

  // Keep bounded — last 50 conversation refs
  if (model.conversations.length > 50) {
    model.conversations = model.conversations.slice(-50);
  }

  model.lastUpdatedAt = new Date().toISOString();
  await store.saveMentalModel(model);
  return true;
}

async function handleUpdateKeywords(inst: Extract<CondenserInstruction, { action: "update_keywords" }>): Promise<boolean> {
  // Keywords are stored in the index, not in the model file directly.
  // We'll handle this during rebuildMemoryIndex by updating the index entry.
  // For now, store them as a metadata field on the model.
  const model = await store.getMentalModel(inst.modelSlug);
  if (!model) return false;

  // Store keywords in model description as a workaround until we add a dedicated field
  // The rebuildMemoryIndex will pick them up from beliefs/relationships
  // TODO: Add a `keywords` field to MentalModel
  model.lastUpdatedAt = new Date().toISOString();
  await store.saveMentalModel(model);
  return true;
}

// ============================================
// THREAD OPERATIONS
// ============================================

async function handleArchiveThread(inst: Extract<CondenserInstruction, { action: "archive_thread" }>): Promise<boolean> {
  return await store.archiveThread(inst.threadId);
}

async function handleCondenseThread(inst: Extract<CondenserInstruction, { action: "condense_thread" }>): Promise<boolean> {
  return await store.condenseThread(
    inst.threadId,
    inst.summary,
    inst.keyPoints,
    inst.preserveLastN ?? 3
  );
}
