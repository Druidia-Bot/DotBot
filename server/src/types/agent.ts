/**
 * Agent Architecture Types
 * 
 * Types for the multi-agent system including classifications,
 * thread indexes, history entries, and message formats.
 */

// ============================================
// REQUEST CLASSIFICATIONS
// ============================================

export type RequestType =
  | "CONVERSATIONAL"    // Casual chat, reply directly
  | "INFO_REQUEST"      // Need more data from client
  | "ACTION"            // Execute something, engage Planner
  | "CLARIFICATION"     // Ambiguous, ask user to clarify
  | "CONTINUATION"      // Continue previous task/thread
  | "CORRECTION"        // User fixing a mistake
  | "CANCELLATION"      // User wants to stop
  | "STATUS_CHECK"      // Report progress
  | "MEMORY_UPDATE"     // Pure fact storage
  | "PREFERENCE"        // User expressing preference
  | "FEEDBACK"          // Rating/critique
  | "COMPOUND"          // Multiple intents
  | "DEFERRED"          // Scheduled for later
  | "DELEGATION";       // Route to specific persona

export type PriorityTag =
  | "URGENT"            // Drop everything
  | "BLOCKING"          // User waiting
  | "BACKGROUND"        // Can run async
  | "SCHEDULED";        // Specific time

// ============================================
// THREAD INDEX LEVELS
// ============================================

/** Level 0: Ultra-compact, always sent (~10-20 tokens per thread) */
export interface ThreadIndexL0 {
  threads: ThreadSummaryL0[];
}

export interface ThreadSummaryL0 {
  id: string;
  topic: string;              // 3-5 words max
  lastActive: string;         // ISO date
  status: "active" | "idle" | "archived";
  entities?: string[];        // Named entities in this thread
  keywords?: string[];        // Keywords for matching
}

/** L0 mental model index entry — just enough for the receptionist to decide if it's relevant */
export interface MemoryIndexL0Entry {
  slug: string;
  name: string;
  category: string;
  description: string;
  keywords: string[];
  lastUpdatedAt: string;
}

/** Level 1: Compact summary, sent on request (~50 tokens per thread) */
export interface ThreadSummaryL1 {
  id: string;
  topic: string;
  keywords: string[];         // 5-10 keywords
  lastMessage: string;        // Truncated to 100 chars
  openLoopCount: number;
  beliefCount: number;
}

/** Level 2: Full packet, only for selected threads */
export interface ThreadPacket {
  id: string;
  topic: string;
  createdAt: string;
  lastActiveAt: string;
  
  // Historical context
  messages: ThreadHistoryEntry[];
  
  // Mental model
  schema: Record<string, PropertyDefinition>;
  beliefs: Belief[];
  
  // Task management
  openLoops: OpenLoop[];
  resolvedIssues: ResolvedIssue[];
  
  // Constraints
  hardConstraints: Constraint[];
  softConstraints: Constraint[];
  
  // Priorities
  priorities: Priority[];
}

// ============================================
// THREAD HISTORY
// ============================================

export interface ThreadHistoryEntry {
  id: string;
  timestamp: string;
  
  user: {
    prompt: string;           // Original prompt (full)
    intent: string;           // What they were trying to do
  };
  
  response: {
    spirit: string;           // Core meaning, 1-2 sentences
    keyPoints: string[];      // 3-5 bullets max
    decisions: string[];      // Decisions made
    commitments: string[];    // Things bot promised
    factsLearned: string[];   // New info extracted
  };
  
  classification: RequestType;
  councilUsed?: string;
  personasInvolved: string[];
  taskIds?: string[];
}

// ============================================
// BELIEFS & CONSTRAINTS
// ============================================

export interface Belief {
  id: string;
  statement: string;
  conviction: number;         // 0-1
  evidence: string[];
  createdAt: string;
  lastUpdated: string;
}

export interface Constraint {
  id: string;
  description: string;
  source: string;             // Where this came from
  createdAt: string;
}

export interface OpenLoop {
  id: string;
  description: string;
  trigger?: string;           // When to address
  priority: "high" | "medium" | "low";
  createdAt: string;
}

export interface ResolvedIssue {
  summary: string;
  resolution: string;
  resolvedAt: string;
}

export interface Priority {
  id: string;
  item: string;
  score: number;              // 0-1
  reason?: string;
}

export interface PropertyDefinition {
  type: "string" | "number" | "boolean" | "array" | "object";
  value?: any;
  description?: string;
}

// ============================================
// RECEPTIONIST OUTPUT
// ============================================

export interface ReceptionistDecision {
  classification: RequestType;
  priority: PriorityTag;
  confidence: number;

  threadIds: string[];
  createNewThread: boolean;
  newThreadTopic?: string;

  // Primary persona to handle this request (from available internal personas)
  personaId?: string;
  // Legacy - still accepted but prefer personaId
  councilId?: string;
  councilNeeded: boolean;

  // Council review — slug of a user-defined council to polish the output
  reviewCouncilSlug?: string;

  reasoning: string;
  formattedRequest?: string;

  // Task duration estimation (for user acknowledgment before long tasks)
  estimatedDurationMs?: number;
  acknowledgmentMessage?: string;

  requestMoreInfo?: {
    type: "thread_summaries" | "thread_packets" | "personas" | "assets";
    threadIds?: string[];
    assetIds?: string[];
  };

  // Memory routing
  memoryAction: "none" | "session_only" | "model_update" | "model_create";
  memoryTargets?: {
    entity: string;
    suggestedType?: "person" | "object" | "place" | "concept" | "event" | "schedule";
    suggestedSubtype?: string;
    existingModelId?: string;
    reasoning: string;
  }[];

  // Model selection hint — receptionist can suggest escalation to a specific model role
  // when it detects the task needs architect-level reasoning or massive context
  modelRole?: "workhorse" | "deep_context" | "architect";

  // For CONVERSATIONAL - can respond directly
  directResponse?: string;

  // For CONTINUATION - resume a tracked task instead of creating a new one
  resumeTaskId?: string;

  // ============================================
  // V2 LOCAL PERSONAS & COUNCILS
  // ============================================

  /** Persona mode — "council" triggers post-execution council review */
  personaMode?: "council";

  /** Slug of the local persona to use (e.g., "alex-hormozi") */
  localPersonaSlug?: string;

  /** Primary task extracted from request (for hybrid persona creation) */
  primaryTask?: string;
}

// ============================================
// PLANNER OUTPUT
// ============================================

export interface ExecutionPlan {
  planId: string;
  tasks: PlannedTask[];
  executionOrder: ExecutionStep[];
  totalEstimatedMs: number;
  reasoning: string;
}

export interface PlannedTask {
  id: string;
  description: string;
  personaId: string;
  personaSource: "client" | "internal";
  estimatedDurationMs: number;
  dependsOn: string[];
  canParallelize: boolean;
  requiredAssets: string[];
  expectedOutput: string;
  /** Tool categories the planner thinks this task needs (e.g. ["discord", "secrets"]).
   *  These expand the persona's tool filter at execution time. */
  requiredToolCategories?: string[];
}

export interface ExecutionStep {
  parallel?: string[];        // Task IDs to run in parallel
  sequential?: string[];      // Task IDs to run in sequence
}

// ============================================
// CHAIRMAN OUTPUT
// ============================================

export interface ChairmanResponse {
  response: string;
  tone: "professional" | "casual" | "technical" | "friendly";
  keyPoints: string[];
  commitments: string[];
  suggestedFollowups: string[];
  confidenceInAnswer: number;
  sourcesUsed: string[];
  personasContributed: string[];
}

// ============================================
// UPDATER OUTPUT
// ============================================

export interface UpdaterRecommendations {
  historyEntry: Omit<ThreadHistoryEntry, "id" | "timestamp">;
  
  beliefUpdates: BeliefUpdate[];
  constraintUpdates: ConstraintUpdate[];
  loopUpdates: LoopUpdate[];
  schemaUpdates: SchemaUpdate[];
  priorityChanges: PriorityChange[];
}

export interface BeliefUpdate {
  action: "add" | "update" | "remove";
  beliefId?: string;
  belief?: Omit<Belief, "id" | "createdAt" | "lastUpdated">;
  changes?: Partial<Belief>;
}

export interface ConstraintUpdate {
  action: "add" | "remove";
  type: "hard" | "soft";
  constraintId?: string;
  constraint?: Omit<Constraint, "id" | "createdAt">;
}

export interface LoopUpdate {
  action: "open" | "close";
  loopId?: string;
  loop?: Omit<OpenLoop, "id" | "createdAt">;
  resolution?: string;
}

export interface SchemaUpdate {
  action: "addProperty" | "removeProperty" | "updateProperty";
  propertyName: string;
  property?: PropertyDefinition;
}

export interface PriorityChange {
  itemId: string;
  newPriority: number;
  reason?: string;
}

// ============================================
// MESSAGE TYPES (Client <-> Server)
// ============================================

/** Enhanced prompt request with context */
export interface EnhancedPromptRequest {
  type: "prompt";
  prompt: string;
  recentHistory: { role: "user" | "assistant"; content: string }[];
  /** The single active thread ID from the local agent (null if no threads yet) */
  activeThreadId: string | null;
  threadIndex: ThreadIndexL0;
  /** L0 mental model index — names + keywords for receptionist routing */
  memoryIndex?: MemoryIndexL0Entry[];
  matchedCouncils?: CouncilMatch[];
  /** @deprecated User personas are now fetched directly by the recruiter */
  userPersonas?: { id: string; name: string; description: string }[];
  /** Recent/active tasks from local agent task log — gives receptionist visibility into in-progress, failed, and blocked work */
  activeTasks?: TaskSnapshot[];
  /** Agent identity skeleton — compact self-model for context injection */
  agentIdentity?: string;
  /** Pre-classification hints from local agent (runs on-device before sending) */
  hints?: {
    /** Local LLM detected multiple unrelated requests in the message */
    multiItem?: boolean;
    /** Suggested persona for routing (e.g., from scheduled tasks) — overrides receptionist pick if valid */
    personaHint?: string;
  };
}

/** Lightweight task snapshot for receptionist context (subset of full Task) */
export interface TaskSnapshot {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "blocked";
  priority: "low" | "medium" | "high";
  personaId?: string;
  threadId?: string;
  originPrompt: string;
  lastError?: string;
  blockedReason?: string;
  updatedAt: string;
  retryCount: number;
}

export interface CouncilMatch {
  id: string;
  name: string;
  description: string;
  triggerMatches: string[];
}

/** Server requests thread data from client */
export interface ThreadDataRequest {
  type: "thread_request";
  requestId: string;
  level: 1 | 2;               // L1 summaries or L2 full packets
  threadIds: string[];
  councilId?: string;         // If L2, also send council personas
}

/** Client responds with thread data */
export interface ThreadDataResponse {
  type: "thread_response";
  requestId: string;
  level: 1 | 2;
  summaries?: ThreadSummaryL1[];
  packets?: ThreadPacket[];
  personas?: PersonaDefinition[];
}

/** Server tells client to save prompt to thread */
export interface SaveToThreadCommand {
  type: "save_to_thread";
  threadId: string;
  createIfMissing: boolean;
  newThreadTopic?: string;
  entry: Omit<ThreadHistoryEntry, "id" | "timestamp">;
}

/** Server sends thread update recommendations */
export interface ThreadUpdateCommand {
  type: "thread_update";
  threadId: string;
  updates: UpdaterRecommendations;
}

/** Asset management messages */
export interface StoreAssetCommand {
  type: "store_asset";
  taskId: string;
  sessionId: string;
  asset: {
    data: string;             // Base64 or URL
    filename: string;
    assetType: "pdf" | "image" | "csv" | "json" | "text";
  };
}

export interface AssetStoredResponse {
  type: "asset_stored";
  taskId: string;
  assetId: string;
  clientPath: string;
}

export interface RetrieveAssetCommand {
  type: "retrieve_asset";
  assetId: string;
  clientPath: string;
}

export interface AssetDataResponse {
  type: "asset_data";
  assetId: string;
  data: string;               // Base64
}

export interface CleanupAssetsCommand {
  type: "cleanup_assets";
  sessionId?: string;
  taskIds?: string[];
}

/** Task progress updates */
export interface TaskProgressUpdate {
  taskId: string;
  status: "running" | "completed" | "failed" | "timeout" | "deferred";
  progress?: number;          // 0-100
  message?: string;
  persona?: string;
  checkpoint?: any;
  /** Which tool was called (e.g. "filesystem.create_file") */
  tool?: string;
  /** Event type for client timeline display */
  eventType?: "tool_call" | "tool_result" | "thinking" | "status";
  /** Whether the tool call succeeded */
  success?: boolean;
  /** Actual character count of the tool result (for execution journal) */
  resultLength?: number;
}

/** Council turn streaming update — sent in real-time as each persona speaks */
export interface CouncilTurnUpdate {
  type: "council_turn";
  councilId: string;
  councilName: string;
  round: number;
  maxRounds: number;
  personaId: string;
  personaName: string;
  message: string;
  model: string;
  provider: string;
  timestamp: number;
  /** Total personas in council */
  totalPersonas: number;
  /** Which persona in the round (1-indexed) */
  personaIndex: number;
}

/** Council consensus check update */
export interface CouncilConsensusUpdate {
  type: "council_consensus";
  councilId: string;
  round: number;
  consensusReached: boolean;
  reasoning: string;
}

/** Council synthesis update — final response being generated */
export interface CouncilSynthesisUpdate {
  type: "council_synthesis";
  councilId: string;
  status: "started" | "completed";
}

// ============================================
// PERSONA DEFINITIONS
// ============================================

export interface PersonaDefinition {
  id: string;
  name: string;
  type: "intake" | "internal" | "client" | "dynamic";
  modelTier: "fast" | "smart" | "powerful";
  description: string;
  systemPrompt: string;
  tools?: string[];
  knowledgeFiles?: string[];
  /** When set, forces this persona to always use the specified model role.
   *  Overrides all task-based detection in selectModel(). */
  modelRole?: "workhorse" | "deep_context" | "architect" | "local" | "gui_fast";
  /** When true, this persona is only used by councils — the receptionist
   *  will NOT see it in the routing table and cannot assign tasks to it. */
  councilOnly?: boolean;
}

/**
 * Extended persona definition for user-defined personas from ~/.bot/personas/.
 * Includes knowledge file references and sync metadata.
 */
export interface LocalPersonaDefinition extends PersonaDefinition {
  type: "client";
  /** Slug identifier (directory name) */
  slug: string;
  /** Knowledge document IDs available for this persona */
  knowledgeDocumentIds?: string[];
  /** Last sync timestamp from local agent */
  lastSyncedAt?: string;
}

/**
 * Council configuration for multi-persona collaboration.
 * Stored in ~/.bot/councils/ on the local agent.
 */
export interface CouncilDefinition {
  id: string;
  name: string;
  description: string;
  /** Persona IDs or slugs (can mix server and local personas) */
  personas: string[];
  /** Regex patterns that auto-trigger this council */
  triggerPatterns?: string[];
  /** If true, this council reviews/polishes existing output (reprocess mode) */
  reviewMode?: boolean;
  /** Custom protocol override (defaults to standard research protocol) */
  protocol?: {
    rounds: number;
    judgeAfterEachRound?: boolean;
    finalSynthesis?: boolean;
  };
  /** User-defined metadata */
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Resolved council with actual PersonaDefinition objects.
 */
export interface ResolvedCouncil {
  id: string;
  name: string;
  description: string;
  personas: PersonaDefinition[];
  reviewMode: boolean;
  protocol: {
    rounds: number;
    judgeAfterEachRound: boolean;
    finalSynthesis: boolean;
  };
}

// ============================================
// KNOWLEDGE MESSAGES
// ============================================

/** Server requests knowledge documents from client */
export interface KnowledgeRequest {
  type: "knowledge_request";
  requestId: string;
  personaSlug: string;
}

/** Client responds with knowledge documents */
export interface KnowledgeResponse {
  type: "knowledge_response";
  requestId: string;
  personaSlug: string;
  documents: KnowledgeDocumentPayload[];
}

/** Knowledge document payload for transfer */
export interface KnowledgeDocumentPayload {
  id: string;
  filename: string;
  title: string;
  description: string;
  content: string;
  tags: string[];
  keywords: string[];
  lastUpdatedAt: string;
  characterCount: number;
}

