/**
 * DotBot Local Agent Types
 * 
 * Shared types for local agent operations
 */

// ============================================
// WEBSOCKET MESSAGES
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
  | "condense_request"
  | "condense_response"
  | "resolve_loop_request"
  | "resolve_loop_response"
  | "user_notification"
  | "tool_request"
  | "tool_result"
  | "agent_started"
  | "agent_complete"
  | "run_log"
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
  | "llm_call_request"
  | "llm_call_response"
  | "credential_resolve_request"
  | "credential_resolve_response"
  | "cancel_before_restart"
  | "cancel_before_restart_ack"
  | "register_device"
  | "device_registered"
  | "auth_failed"
  | "admin_request"
  | "admin_response"
  | "task_acknowledged"
  | "error"
  | "ping"
  | "pong";

export interface WSMessage {
  type: WSMessageType;
  id: string;
  timestamp: number;
  payload: any;
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

// ============================================
// EXECUTION
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

// ============================================
// SCHEMA
// ============================================

export interface SchemaReport {
  type: "spreadsheet" | "document" | "directory" | "database" | "unknown";
  path: string;
  structure: any;
  preview: string;
}

// ============================================
// MEMORY REQUESTS
// ============================================

export type MemoryAction = 
  | "get_index"
  | "get_model"
  | "create_model"
  | "update_model"
  | "add_belief"
  | "add_open_loop"
  | "resolve_open_loop"
  | "add_question"
  | "add_constraint"
  | "save_model"
  | "search_models"
  | "get_schema"
  | "update_schema"
  | "get_l0_index"
  | "get_model_detail"
  | "get_thread_detail"
  | "get_recent_history"
  | "create_task"
  | "update_task"
  | "update_task_step"
  | "get_task"
  | "get_tasks"
  | "get_resumable_tasks"
  | "flush_session"
  | "clear_threads"
  | "get_identity"
  | "get_model_skeletons"
  | "search_and_promote";

export interface MemoryRequest {
  action: MemoryAction;
  requestId: string;
  /** Model slug for model-specific operations */
  modelSlug?: string;
  /** Category for schema operations */
  category?: string;
  /** Search query */
  query?: string;
  /** Data payload for create/update operations */
  data?: any;
}

export interface MemoryResult {
  requestId: string;
  success: boolean;
  data?: any;
  error?: string;
}

// ============================================
// SKILL REQUESTS
// ============================================

export type SkillAction =
  | "get_index"
  | "get_skill"
  | "create_skill"
  | "search_skills"
  | "delete_skill";

export interface SkillRequest {
  action: SkillAction;
  requestId: string;
  /** Skill slug for skill-specific operations */
  skillSlug?: string;
  /** Search query */
  query?: string;
  /** Language filter for search */
  language?: string;
  /** Data payload for create/update operations */
  data?: any;
}
