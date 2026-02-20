/**
 * Memory & Threading Types
 *
 * Mental models, dialog summaries, threads, session memory,
 * and memory delta types for the episodic memory system.
 */

// --- Schema Evolution ---

export interface SchemaField {
  key: string;                    // e.g. "year", "make", "engine_type"
  type: "string" | "number" | "boolean" | "date" | "string[]" | "object";
  description: string;            // WHY this field matters for this entity
  addedAt: Date;                  // When this field was added to the schema
  addedFrom?: string;             // Thread/session that prompted adding it
  required: boolean;              // Core field vs optional context
  populated: boolean;             // Do we have a value yet?
}

// --- Dialog Summary (stored on model, not full conversation) ---

export interface DialogSummary {
  id: string;
  timestamp: Date;
  userIntent: string;             // What the user asked/wanted
  spirit: string;                 // 1-2 sentence outcome summary
  keyPoints: string[];            // Factual bullet points
  decisions: string[];            // Decisions made
  openLoops: string[];            // Unresolved questions/next steps
  threadId?: string;              // Which thread this came from
}

// --- Mental Model (with dynamic schema + dialog history) ---

export interface MentalModel {
  id: string;
  entity: string;
  type: "person" | "object" | "place" | "concept" | "event" | "schedule";
  subtype?: string;               // e.g. "spouse", "coworker", "vehicle", "project"
  
  schema: SchemaField[];          // Dynamic, evolving per-entity schema
  attributes: Record<string, any>;
  relationships: Relationship[];
  
  recentDialog: DialogSummary[];  // Summaries of interactions about this entity
  beliefs: ModelBelief[];         // Things we believe about this entity
  openLoops: OpenLoop[];          // Unresolved questions/actions
  constraints: ModelConstraint[]; // Hard/soft constraints related to this entity
  
  createdAt: Date;
  lastUpdated: Date;
  confidence: number;
  sourceThreads: string[];
}

export interface ModelBelief {
  id: string;
  statement: string;
  conviction: number;             // 0.0-1.0
  evidence: string[];             // What supports this belief
  addedAt: Date;
  lastConfirmedAt?: Date;
}

export interface OpenLoop {
  id: string;
  description: string;
  trigger?: string;               // What would resolve this loop
  priority: "high" | "medium" | "low";
  createdAt: Date;
  resolvedAt?: Date;
  resolution?: string;
}

export interface ModelConstraint {
  id: string;
  type: "hard" | "soft";
  description: string;
  source: string;                 // How we learned this constraint
  addedAt: Date;
}

export interface Relationship {
  type: string;
  target: string;                 // Mental model ID or entity name
  metadata?: Record<string, any>;
}

// --- Memory Delta (LLM proposes, system disposes) ---

export interface MemoryDelta {
  entity: string;
  modelId?: string;               // Existing model ID, or undefined → create new
  type?: MentalModel["type"];     // Required if creating new
  subtype?: string;               // Required if creating new
  
  summary: DialogSummary;         // Always required — distilled interaction summary
  
  additions: {
    schema?: Omit<SchemaField, "addedAt" | "populated">[];  // New fields to track
    attributes?: Record<string, any>;                        // New or updated values
    relationships?: Relationship[];
    beliefs?: Omit<ModelBelief, "id" | "addedAt">[];
    openLoops?: Omit<OpenLoop, "id" | "createdAt">[];
    constraints?: Omit<ModelConstraint, "id" | "addedAt">[];
  };
  
  deductions: {
    schemaKeys?: string[];        // Schema fields no longer relevant (rare)
    attributeKeys?: string[];     // Values to clear
    beliefIds?: string[];         // Beliefs to remove or weaken
    loopIds?: string[];           // Loops to close (with resolution)
    loopResolutions?: Record<string, string>;  // loopId → resolution text
    constraintIds?: string[];     // Constraints to remove
    relationshipTargets?: string[];  // Relationship targets to remove
  };
  
  reasoning: string;              // Why these changes
}

// --- Session Memory (Working Memory) ---

export interface SessionMemory {
  id: string;
  userId: string;
  startedAt: Date;
  lastActiveAt: Date;
  
  entries: SessionEntry[];
  
  activeContext: {
    entityIds: string[];          // Mental model IDs currently relevant
    recentTopics: string[];       // Extracted from last N turns
    lastAction?: string;          // "Created hello_world.txt on Desktop"
  };
}

export interface SessionEntry {
  id: string;
  timestamp: Date;
  type: "user_message" | "assistant_response" | "tool_action" | "observation" | "error";
  content: string;
  metadata?: Record<string, any>;
  mentalModelId?: string;         // If this entry also updated a model
}

export interface Thread {
  id: string;
  topic: string;
  summary: string;
  entities: string[]; // Mental model IDs
  keywords: string[];
  messages: ThreadMessage[];
  createdAt: Date;
  lastActiveAt: Date;
  status: "active" | "dormant" | "archived";
}

export interface ThreadMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  personaId?: string;
  fromThread?: string; // If cross-thread communication
  metadata?: Record<string, any>;
}

export interface ThreadMatch {
  threadId: string;
  relevance: number; // 0-1
  reason: string;
}

// Memory action types for receptionist routing
export type MemoryAction = "none" | "session_only" | "model_update" | "model_create";

export interface MemoryTarget {
  entity: string;
  suggestedType?: MentalModel["type"];
  suggestedSubtype?: string;
  existingModelId?: string;
  reasoning: string;
}
