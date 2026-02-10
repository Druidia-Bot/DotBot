/**
 * DotBot Core Types
 * 
 * Defines the type system for:
 * - Council of Agents (personas, paths)
 * - Episodic Memory (threads, mental models)
 * - Local-Cloud Communication (commands, results)
 */

// ============================================
// MODEL & PERSONA TYPES
// ============================================

// Provider-agnostic types - see llm/providers.ts for full implementation
export type LLMProvider = "deepseek" | "anthropic" | "openai" | "gemini" | "local";
export type ModelTier = "fast" | "smart" | "powerful";

// ============================================
// MEMORY & THREADING TYPES
// ============================================

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

// ============================================
// MEMORY TYPES
// ============================================

// Memory action types for receptionist routing
export type MemoryAction = "none" | "session_only" | "model_update" | "model_create";

export interface MemoryTarget {
  entity: string;
  suggestedType?: MentalModel["type"];
  suggestedSubtype?: string;
  existingModelId?: string;
  reasoning: string;
}

// ============================================
// EXECUTION TYPES
// ============================================

export type ExecutionType = 
  | "powershell" 
  | "wsl" 
  | "browser" 
  | "file_read" 
  | "file_write"
  | "schema_extract"
  | "clipboard"
  | "tool_execute";

export interface ExecutionCommand {
  id: string;
  type: ExecutionType;
  payload: {
    script?: string;
    action?: string;
    path?: string;
    content?: string;
    args?: string[];
    /** For tool_execute: the dotted tool ID (e.g. "filesystem.create_file") */
    toolId?: string;
    /** For tool_execute: the tool arguments as key-value pairs */
    toolArgs?: Record<string, any>;
  };
  dryRun: boolean;
  timeout: number;
  sandboxed: boolean;
  requiresApproval: boolean;
}

export interface ExecutionResult {
  commandId: string;
  success: boolean;
  output: string;
  error?: string;
  duration: number;
  sideEffects?: string[];
}

export interface SchemaReport {
  type: "spreadsheet" | "document" | "directory" | "database" | "unknown";
  path: string;
  structure: any;
  preview: string;
}

// ============================================
// SESSION & USER TYPES
// ============================================

export interface UserProfile {
  id: string;
  email: string;
  trustLevel: "basic" | "standard" | "power";
  customPersonas?: { id: string; name: string; description: string }[];
  customPaths?: { id: string; name: string; description: string; personas: string[]; triggers: string[] }[];
  preferences: {
    defaultPath?: string;
    verbosity?: "minimal" | "normal" | "detailed";
    confirmDestructive?: boolean;
  };
  metrics: {
    successfulExecutions: number;
    failedExecutions: number;
    daysActive: number;
  };
  createdAt: Date;
}

export interface DeviceSession {
  id: string;
  userId: string;
  deviceId: string;
  deviceName: string;
  capabilities: string[];
  tempDir?: string;
  connectedAt: Date;
  lastActiveAt: Date;
  status: "connected" | "disconnected";
}

// ============================================
// COUNCIL REVIEW TYPES (Councils = Polishers)
// ============================================

/**
 * A council member as loaded on the server for execution.
 * Combines persona info + council-specific overrides.
 */
export interface CouncilMemberRuntime {
  personaSlug: string;
  councilRole: string;
  sequence: number;
  required: boolean;
  systemPrompt: string;                   // From the persona
  reviewFocus?: string;                    // Council-specific review lens
  providerOverride?: LLMProvider;
  modelOverride?: string;
}

/**
 * A council definition as loaded on the server for execution.
 */
export interface CouncilRuntime {
  slug: string;
  name: string;
  mission: string;
  principles: { id: string; title: string; description: string; priority: number }[];
  members: CouncilMemberRuntime[];
  executionMode: "single_pass" | "iterative";
  maxIterations: number;                   // Default 3
}

/**
 * What each council member returns after reviewing work.
 */
export interface CouncilVerdict {
  memberSlug: string;
  councilRole: string;
  approved: boolean;
  feedback: string;
  suggestedChanges?: string;
  confidence: number;                      // 0-1
  duration: number;                        // ms
}

/**
 * A single iteration of the council review loop.
 */
export interface CouncilIteration {
  round: number;
  verdicts: CouncilVerdict[];
  allRequiredApproved: boolean;
  revisedOutput?: string;                  // If work was revised based on feedback
}

/**
 * The full result of a council review pass.
 */
export interface CouncilReviewResult {
  councilSlug: string;
  approved: boolean;                       // All required members approved
  iterations: CouncilIteration[];
  totalIterations: number;
  finalOutput: string;                     // The polished output
  combinedFeedback: string;                // Summary of all feedback
}

// ============================================
// WEBSOCKET MESSAGE TYPES
// ============================================

export type WSMessageType = 
  | "auth"
  | "prompt"
  | "response"
  | "stream_chunk"
  | "execution_request"
  | "execution_result"
  | "schema_request"
  | "schema_result"
  | "memory_request"
  | "memory_result"
  | "skill_request"
  | "skill_result"
  | "persona_request"
  | "persona_result"
  | "council_request"
  | "council_result"
  | "knowledge_request"
  | "knowledge_result"
  | "knowledge_query"
  | "knowledge_query_result"
  | "thread_request"
  | "thread_response"
  | "thread_update"
  | "task_progress"
  | "store_asset"
  | "asset_stored"
  | "retrieve_asset"
  | "asset_data"
  | "cleanup_assets"
  | "save_to_thread"
  | "log"
  | "log_subscribe"
  | "log_query"
  | "error"
  | "ping"
  | "pong"
  | "llm_request"
  | "llm_response"
  | "gateway_decision"
  | "receptionist_decision"
  | "planner_output"
  | "condense_request"
  | "condense_response"
  | "resolve_loop_request"
  | "resolve_loop_response"
  | "user_notification"
  | "tool_request"
  | "tool_result"
  | "run_log"
  | "agent_started"
  | "agent_complete"
  | "save_agent_work"
  | "format_fix_request"
  | "format_fix_response"
  | "heartbeat_request"
  | "heartbeat_response"
  | "credential_session_request"
  | "credential_session_ready"
  | "credential_stored"
  | "credential_proxy_request"
  | "credential_proxy_response"
  | "credential_resolve_request"
  | "credential_resolve_response"
  | "cancel_before_restart"
  | "cancel_before_restart_ack"
  | "register_device"
  | "device_registered"
  | "auth_failed"
  | "admin_request"
  | "admin_response";

export interface WSMessage {
  type: WSMessageType;
  id: string;
  timestamp: number;
  payload: any;
}

export interface WSAuthMessage extends WSMessage {
  type: "auth";
  payload: {
    deviceToken?: string;
    deviceId: string;
    deviceSecret: string;
    deviceName: string;
    capabilities: string[];
    tempDir?: string;
    hwFingerprint: string;
  };
}

export interface WSRegisterDeviceMessage extends WSMessage {
  type: "register_device";
  payload: {
    inviteToken: string;
    label: string;
    hwFingerprint: string;
    capabilities: string[];
    tempDir?: string;
  };
}

export interface WSPromptMessage extends WSMessage {
  type: "prompt";
  payload: {
    prompt: string;
    context?: Record<string, any>;
  };
}

export interface WSStreamChunk extends WSMessage {
  type: "stream_chunk";
  payload: {
    personaId: string;
    content: string;
    done: boolean;
  };
}

// ============================================
// HEARTBEAT TYPES
// ============================================

export interface HeartbeatResult {
  status: "ok" | "alert" | "error";
  content: string;          // Display text (alert message or brief summary)
  checkedAt: string;        // ISO timestamp when the check completed
  durationMs: number;       // How long the server-side evaluation took
  model: string;            // Which LLM model was used
  toolsAvailable: boolean;  // Whether tool loop was available for this check
  scheduledTasks?: {        // #5: Scheduler integration — task counts for this user
    due: number;            // Tasks past their scheduled time
    upcoming: number;       // Tasks scheduled within the next hour
    total: number;          // Total scheduled (not yet executed) tasks
  };
}
