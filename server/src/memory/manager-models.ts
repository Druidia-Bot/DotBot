/**
 * Memory Manager — Mental Model Operations
 * 
 * CRUD for mental models and MemoryDelta application.
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "#logging.js";
import type {
  MentalModel,
  Relationship,
  SchemaField,
  DialogSummary,
  ModelBelief,
  OpenLoop,
  ModelConstraint,
  MemoryDelta,
} from "../types.js";
import { store } from "./manager-store.js";

const log = createComponentLogger("memory");

// ============================================
// MENTAL MODEL CRUD
// ============================================

export function createMentalModel(
  userId: string,
  entity: string,
  type: MentalModel["type"],
  subtype?: string,
  attributes: Record<string, any> = {}
): MentalModel {
  const model: MentalModel = {
    id: `mm_${nanoid()}`,
    entity,
    type,
    subtype,
    schema: [],
    attributes,
    relationships: [],
    recentDialog: [],
    beliefs: [],
    openLoops: [],
    constraints: [],
    createdAt: new Date(),
    lastUpdated: new Date(),
    confidence: 0.7,
    sourceThreads: []
  };

  store.mentalModels.set(model.id, model);
  
  const userModels = store.userModels.get(userId) || [];
  userModels.push(model.id);
  store.userModels.set(userId, userModels);

  log.info(`Created mental model: ${entity} (${type}${subtype ? '/' + subtype : ''})`, { modelId: model.id });
  return model;
}

export function getMentalModel(modelId: string): MentalModel | undefined {
  return store.mentalModels.get(modelId);
}

export function getUserMentalModels(userId: string): MentalModel[] {
  const modelIds = store.userModels.get(userId) || [];
  return modelIds
    .map(id => store.mentalModels.get(id))
    .filter((m): m is MentalModel => m !== undefined);
}

export function findMentalModelByEntity(userId: string, entity: string): MentalModel | undefined {
  const models = getUserMentalModels(userId);
  return models.find(m => 
    m.entity.toLowerCase() === entity.toLowerCase()
  );
}

export function linkModelToThread(modelId: string, threadId: string): void {
  const model = store.mentalModels.get(modelId);
  if (model && !model.sourceThreads.includes(threadId)) {
    model.sourceThreads.push(threadId);
  }
}

// ============================================
// MEMORY DELTA APPLICATION
// ============================================

/**
 * Apply a MemoryDelta to a mental model. This is the ONLY way models get updated.
 * The LLM proposes deltas; this function applies them programmatically.
 * 
 * If modelId is provided and exists, updates that model.
 * If entity matches an existing model, updates that model.
 * Otherwise, creates a new model.
 * 
 * Returns the affected model.
 */
export function applyMemoryDelta(
  userId: string,
  delta: MemoryDelta
): MentalModel {
  const now = new Date();
  
  // Find or create the model
  let model = delta.modelId
    ? getMentalModel(delta.modelId)
    : findMentalModelByEntity(userId, delta.entity);
  
  if (!model) {
    model = createMentalModel(
      userId,
      delta.entity,
      delta.type || "concept",
      delta.subtype
    );
    log.info(`New model created from delta: ${delta.entity}`, { modelId: model.id });
  }

  // --- APPLY ADDITIONS ---
  const { additions } = delta;
  
  if (additions.schema) {
    for (const fieldDef of additions.schema) {
      const exists = model.schema.some(f => f.key === fieldDef.key);
      if (!exists) {
        const field: SchemaField = {
          ...fieldDef,
          addedAt: now,
          populated: false,
        };
        model.schema.push(field);
        log.debug(`Schema field added: ${fieldDef.key} on ${model.entity}`);
      }
    }
  }
  
  if (additions.attributes) {
    for (const [key, value] of Object.entries(additions.attributes)) {
      model.attributes[key] = value;
      const schemaField = model.schema.find(f => f.key === key);
      if (schemaField) {
        schemaField.populated = true;
      }
    }
  }
  
  if (additions.relationships) {
    for (const rel of additions.relationships) {
      const exists = model.relationships.some(
        r => r.type === rel.type && r.target === rel.target
      );
      if (!exists) {
        model.relationships.push(rel);
      }
    }
  }
  
  if (additions.beliefs) {
    for (const belief of additions.beliefs) {
      const fullBelief: ModelBelief = {
        ...belief,
        id: `belief_${nanoid(8)}`,
        addedAt: now,
      };
      model.beliefs.push(fullBelief);
    }
  }
  
  if (additions.openLoops) {
    for (const loop of additions.openLoops) {
      const fullLoop: OpenLoop = {
        ...loop,
        id: `loop_${nanoid(8)}`,
        createdAt: now,
      };
      model.openLoops.push(fullLoop);
    }
  }
  
  if (additions.constraints) {
    for (const constraint of additions.constraints) {
      const fullConstraint: ModelConstraint = {
        ...constraint,
        id: `constraint_${nanoid(8)}`,
        addedAt: now,
      };
      model.constraints.push(fullConstraint);
    }
  }

  // --- APPLY DEDUCTIONS ---
  const { deductions } = delta;
  
  if (deductions.schemaKeys?.length) {
    model.schema = model.schema.filter(f => !deductions.schemaKeys!.includes(f.key));
    for (const key of deductions.schemaKeys) {
      delete model.attributes[key];
    }
    log.debug(`Schema fields removed: ${deductions.schemaKeys.join(", ")} from ${model.entity}`);
  }
  
  if (deductions.attributeKeys?.length) {
    for (const key of deductions.attributeKeys) {
      delete model.attributes[key];
      const schemaField = model.schema.find(f => f.key === key);
      if (schemaField) schemaField.populated = false;
    }
  }
  
  if (deductions.beliefIds?.length) {
    model.beliefs = model.beliefs.filter(b => !deductions.beliefIds!.includes(b.id));
  }
  
  if (deductions.loopIds?.length) {
    for (const loopId of deductions.loopIds) {
      const loop = model.openLoops.find(l => l.id === loopId);
      if (loop) {
        loop.resolvedAt = now;
        loop.resolution = deductions.loopResolutions?.[loopId] || "Resolved";
      }
    }
  }
  
  if (deductions.constraintIds?.length) {
    model.constraints = model.constraints.filter(c => !deductions.constraintIds!.includes(c.id));
  }
  
  if (deductions.relationshipTargets?.length) {
    model.relationships = model.relationships.filter(
      r => !deductions.relationshipTargets!.includes(r.target)
    );
  }

  // --- ALWAYS: Store dialog summary ---
  const summary: DialogSummary = {
    ...delta.summary,
    id: delta.summary.id || `dialog_${nanoid(8)}`,
    timestamp: delta.summary.timestamp || now,
  };
  model.recentDialog.push(summary);
  if (model.recentDialog.length > 20) {
    model.recentDialog = model.recentDialog.slice(-20);
  }

  // Update metadata
  model.lastUpdated = now;
  model.confidence = Math.min(1, model.confidence + 0.05);
  
  log.info(`Delta applied to ${model.entity}`, {
    modelId: model.id,
    schemaAdded: additions.schema?.length || 0,
    attrsAdded: additions.attributes ? Object.keys(additions.attributes).length : 0,
    beliefsAdded: additions.beliefs?.length || 0,
    loopsAdded: additions.openLoops?.length || 0,
    deductions: {
      schemaRemoved: deductions.schemaKeys?.length || 0,
      attrsRemoved: deductions.attributeKeys?.length || 0,
      beliefsClosed: deductions.beliefIds?.length || 0,
      loopsClosed: deductions.loopIds?.length || 0,
    },
    reasoning: delta.reasoning,
  });

  return model;
}

/**
 * Apply multiple deltas in sequence. Used when updater returns deltas for multiple entities.
 */
export function applyMemoryDeltas(
  userId: string,
  deltas: MemoryDelta[]
): MentalModel[] {
  return deltas.map(delta => applyMemoryDelta(userId, delta));
}
