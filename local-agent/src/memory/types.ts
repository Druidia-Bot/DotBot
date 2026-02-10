/**
 * Local Memory Types
 * 
 * Mental models with evolving schemas, beliefs, evidence, and open loops.
 * Skills system for reusable code patterns.
 * 
 * All stored as JSON files on the user's local machine.
 */

// ============================================
// AGENT IDENTITY (Self-Model)
// ============================================

/**
 * Agent identity — the "me" construct.
 * Lives at ~/.bot/me.json. Represents who the orchestrator agent is:
 * core personality, ethics, code of conduct, human-given instructions,
 * and non-secure properties (email, timezone, etc.).
 * 
 * Updated ONLY via programmatic add/remove instructions (never raw LLM writes).
 * Updated rarely — only when core identity information changes.
 */
export interface AgentIdentity {
  /** Agent's display name (e.g., "Dot") */
  name: string;
  /** One-line role description */
  role: string;
  /** Core personality traits */
  traits: string[];
  /** Hard ethical boundaries — things the agent will never do */
  ethics: string[];
  /** Behavioral rules — how the agent conducts itself */
  codeOfConduct: string[];
  /** Non-secure properties (email, timezone, etc.) */
  properties: Record<string, string>;
  /** Instructions the human has given about how the agent should behave */
  humanInstructions: string[];
  /** Preferred communication style keywords */
  communicationStyle: string[];
  /** Version — bumped on each update for change tracking */
  version: number;
  createdAt: string;
  lastUpdatedAt: string;
}

// ============================================
// MENTAL MODEL SCHEMA (Self-Describing)
// ============================================

/**
 * Schema field definition - describes what attributes are relevant for a type of thing
 */
export interface SchemaField {
  name: string;
  type: "string" | "number" | "boolean" | "date" | "array" | "object";
  description: string;
  required: boolean;
  /** Example values to help understand what this field captures */
  examples?: string[];
  /** When was this field added to the schema */
  addedAt: string;
  /** What prompted adding this field */
  addedReason?: string;
}

/**
 * Evolving schema for a category of mental models
 * e.g., "person", "vehicle", "project", "place"
 */
export interface ModelSchema {
  /** Category this schema applies to */
  category: string;
  /** Human-readable description of what this category represents */
  description: string;
  /** Fields that are relevant for this type of thing */
  fields: SchemaField[];
  /** When this schema was created */
  createdAt: string;
  /** When this schema was last modified */
  lastUpdatedAt: string;
  /** Version number, incremented on each update */
  version: number;
}

// ============================================
// BELIEFS & EVIDENCE
// ============================================

/**
 * A single belief about an entity
 */
export interface Belief {
  /** Unique ID for this belief */
  id: string;
  /** The attribute/property this belief is about */
  attribute: string;
  /** The believed value */
  value: any;
  /** How confident we are (0-1) */
  confidence: number;
  /** Why we believe this */
  evidence: Evidence[];
  /** When this belief was formed */
  formedAt: string;
  /** When this belief was last confirmed or updated */
  lastConfirmedAt: string;
  /** Has this belief been contradicted? */
  contradicted?: {
    by: string;
    at: string;
    resolution?: string;
  };
}

/**
 * Evidence supporting a belief
 */
export interface Evidence {
  /** What type of evidence */
  type: "user_stated" | "inferred" | "observed" | "external";
  /** The actual evidence content */
  content: string;
  /** When this evidence was collected */
  timestamp: string;
  /** Source of the evidence (conversation ID, file, etc.) */
  source: string;
  /** How strong is this evidence (0-1) */
  strength: number;
}

// ============================================
// OPEN LOOPS & QUESTIONS
// ============================================

/**
 * An open loop - something unresolved or incomplete
 */
export interface OpenLoop {
  id: string;
  /** What is unresolved */
  description: string;
  /** Why does this matter */
  importance: "low" | "medium" | "high";
  /** When was this identified */
  identifiedAt: string;
  /** What would close this loop */
  resolutionCriteria: string;
  /** Related beliefs that depend on this */
  relatedBeliefs?: string[];
  /** Status */
  status: "open" | "investigating" | "blocked" | "resolved";
  /** If resolved, what was the resolution */
  resolution?: string;
}

/**
 * A question we want to ask to improve the model
 */
export interface ModelQuestion {
  id: string;
  /** The question to ask */
  question: string;
  /** Why asking this would help */
  purpose: string;
  /** Priority of asking this */
  priority: "low" | "medium" | "high";
  /** What beliefs/loops would this inform */
  informs: string[];
  /** When was this question generated */
  generatedAt: string;
  /** Has it been asked? */
  asked?: {
    at: string;
    answer?: string;
  };
}

// ============================================
// CONSTRAINTS
// ============================================

/**
 * A constraint on the mental model
 */
export interface Constraint {
  id: string;
  /** What is constrained */
  description: string;
  /** Hard constraints are rules that cannot be violated */
  type: "hard" | "soft";
  /** For soft constraints, how much flexibility */
  flexibility?: "low" | "medium" | "high";
  /** When was this constraint identified */
  identifiedAt: string;
  /** Source of the constraint */
  source: string;
  /** Is this constraint still active */
  active: boolean;
  /** When does this constraint expire (if ever) */
  expiresAt?: string;
}

// ============================================
// RELATIONSHIPS
// ============================================

/**
 * A relationship to another mental model
 */
export interface Relationship {
  /** Type of relationship */
  type: string;
  /** Slug of the target mental model */
  targetSlug: string;
  /** Direction of the relationship */
  direction: "outgoing" | "incoming" | "bidirectional";
  /** Additional context */
  context?: string;
  /** When was this relationship identified */
  identifiedAt: string;
  /** Confidence in this relationship */
  confidence: number;
}

// ============================================
// RESOLVED ISSUES (Lightweight Loop Summaries)
// ============================================

/**
 * A resolved open loop — just the summary, not the full tracking object.
 * Once a loop is resolved and doesn't need to become a belief or constraint,
 * we collapse it to this lightweight record.
 */
export interface ResolvedIssue {
  /** Original loop description */
  summary: string;
  /** How it was resolved */
  resolution: string;
  /** When it was resolved */
  resolvedAt: string;
}

// ============================================
// MENTAL MODEL (Main Entity)
// ============================================

/**
 * A mental model represents our understanding of an entity
 */
export interface MentalModel {
  /** URL-safe identifier */
  slug: string;
  /** Human-readable name */
  name: string;
  /** Brief description */
  description: string;
  /** Category (maps to a ModelSchema) */
  category: "person" | "place" | "object" | "project" | "concept" | "event" | "organization" | string;
  
  /** Current beliefs about this entity */
  beliefs: Belief[];
  
  /** Open loops - unresolved questions/gaps */
  openLoops: OpenLoop[];
  
  /** Resolved issues — lightweight summaries of closed loops */
  resolvedIssues: ResolvedIssue[];
  
  /** Questions we want to ask */
  questions: ModelQuestion[];
  
  /** Constraints on this model */
  constraints: Constraint[];
  
  /** Relationships to other mental models */
  relationships: Relationship[];
  
  /** Conversation history relevant to this model */
  conversations: ConversationReference[];
  
  /** When was this model created */
  createdAt: string;
  /** When was this model last updated */
  lastUpdatedAt: string;
  /** How many times has this model been accessed */
  accessCount: number;
}

/**
 * Reference to a conversation that informed this model
 */
export interface ConversationReference {
  /** Timestamp of the conversation */
  timestamp: string;
  /** Brief summary of what was discussed */
  summary: string;
  /** Key points extracted */
  keyPoints: string[];
}

// ============================================
// INDEX FILE
// ============================================

/**
 * Index entry for quick lookup without loading full model
 */
export interface MentalModelIndexEntry {
  slug: string;
  name: string;
  description: string;
  category: string;
  /** Keywords for search */
  keywords: string[];
  createdAt: string;
  lastUpdatedAt: string;
  /** Number of beliefs */
  beliefCount: number;
  /** Number of open loops */
  openLoopCount: number;
}

/**
 * Schema index entry
 */
export interface SchemaIndexEntry {
  category: string;
  description: string;
  fieldCount: number;
  version: number;
  lastUpdatedAt: string;
}

/**
 * Master index file structure
 */
export interface MemoryIndex {
  version: string;
  lastUpdatedAt: string;
  models: MentalModelIndexEntry[];
  schemas: SchemaIndexEntry[];
}

// ============================================
// SLEEP CYCLE: CONDENSER INSTRUCTIONS
// ============================================

/**
 * A single instruction returned by the server's condenser LLM.
 * The local agent applies these programmatically — the LLM never rewrites full models.
 */
export type CondenserInstruction =
  | { action: "add_belief"; modelSlug: string; belief: Omit<Belief, "evidence"> & { evidence?: Evidence[] } }
  | { action: "update_belief"; modelSlug: string; beliefId: string; updates: { value?: any; confidence?: number; evidence?: Evidence } }
  | { action: "remove_belief"; modelSlug: string; beliefId: string; reason: string }
  | { action: "add_constraint"; modelSlug: string; constraint: Omit<Constraint, "active"> }
  | { action: "remove_constraint"; modelSlug: string; constraintId: string; reason: string }
  | { action: "add_open_loop"; modelSlug: string; loop: Omit<OpenLoop, "status"> & { toolHint?: string } }
  | { action: "close_loop"; modelSlug: string; loopId: string; resolution: string }
  | { action: "update_loop_status"; modelSlug: string; loopId: string; status: "investigating" | "blocked"; reason: string }
  | { action: "add_relationship"; modelSlug: string; relationship: Relationship }
  | { action: "remove_relationship"; modelSlug: string; targetSlug: string; type: string }
  | { action: "create_model"; slug: string; name: string; category: string; description: string; initialBeliefs?: Omit<Belief, "evidence">[] }
  | { action: "update_model_meta"; modelSlug: string; updates: { name?: string; description?: string; category?: string } }
  | { action: "add_conversation_ref"; modelSlug: string; ref: ConversationReference }
  | { action: "update_keywords"; modelSlug: string; keywords: string[] }
  | { action: "archive_thread"; threadId: string }
  | { action: "condense_thread"; threadId: string; summary: string; keyPoints: string[]; preserveLastN?: number }
  // Identity instructions — rare, only for core identity changes
  | { action: "identity_add_trait"; value: string }
  | { action: "identity_remove_trait"; value: string }
  | { action: "identity_add_ethic"; value: string }
  | { action: "identity_remove_ethic"; value: string }
  | { action: "identity_add_conduct"; value: string }
  | { action: "identity_remove_conduct"; value: string }
  | { action: "identity_set_property"; key: string; value: string }
  | { action: "identity_remove_property"; key: string }
  | { action: "identity_add_instruction"; value: string }
  | { action: "identity_remove_instruction"; value: string }
  | { action: "identity_add_communication_style"; value: string }
  | { action: "identity_remove_communication_style"; value: string }
  | { action: "identity_set_name"; value: string }
  | { action: "identity_set_role"; value: string };

/**
 * Request from local agent to server: "condense this thread"
 */
export interface CondenseRequest {
  /** Thread data (messages, topic, entities) */
  thread: any;
  /** L0 index of existing models (so the LLM knows what models exist) */
  modelIndex: { slug: string; name: string; category: string; keywords: string[] }[];
  /** Full models that are likely relevant (pre-fetched by local agent based on thread entities) */
  relevantModels: any[];
  /** Timestamp of last sleep cycle (only condense messages after this) */
  lastCycleAt?: string;
}

/**
 * Response from server: structured instructions to apply
 */
export interface CondenseResponse {
  instructions: CondenserInstruction[];
  /** Summary of what the condenser decided */
  reasoning: string;
}

/**
 * Request from local agent to server: "try to resolve this open loop"
 */
export interface ResolveLoopRequest {
  /** The open loop to try resolving */
  loop: OpenLoop;
  /** The model this loop belongs to */
  modelSlug: string;
  modelName: string;
  /** Context: recent beliefs about this entity */
  contextBeliefs: { attribute: string; value: any }[];
  /** Available tool hints (web_search, email_lookup, etc.) */
  availableTools: string[];
}

/**
 * Response from server: loop resolution result
 */
export interface ResolveLoopResult {
  /** Did we find useful information? */
  resolved: boolean;
  /** If resolved, what was found */
  resolution?: string;
  /** If not resolved, why */
  blockedReason?: string;
  /** Should we notify the user? */
  notifyUser: boolean;
  /** Notification message for the user */
  notification?: string;
  /** New status for the loop */
  newStatus: "resolved" | "blocked" | "investigating";
  /** Any additional instructions to apply (e.g., new beliefs from the research) */
  sideEffects?: CondenserInstruction[];
}

/**
 * Sleep cycle state — persisted to track when the last cycle ran
 */
export interface SleepCycleState {
  lastCycleAt: string;
  lastCycleDurationMs: number;
  threadsProcessed: number;
  loopsInvestigated: number;
  instructionsApplied: number;
}


// Task, Skill, Tool, Persona & Council types — split to types-tools.ts
export type {
  TaskStatus, TaskStep, Task, TaskLog,
  JSONSchema, MCPToolAnnotations, MCPTool,
  SkillFrontmatter, Skill, SkillIndexEntry,
  DotBotTool, ToolManifestEntry, ToolRegistry,
  Persona, KnowledgeDocument, PersonaIndexEntry, PersonasIndex,
  CouncilMember, GoverningPrinciple, Council, CouncilIndexEntry, CouncilsIndex,
} from "./types-tools.js";

