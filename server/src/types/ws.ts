/**
 * WebSocket Message Types
 *
 * All WS message type unions and typed message interfaces
 * for server ↔ local-agent communication.
 */

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
  | "council_turn"
  | "council_consensus"
  | "council_synthesis"
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
  | "dispatch_followup"
  | "mcp_configs";

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
    /** Client platform for V2 tool filtering. */
    platform?: "windows" | "linux" | "macos";
    /** Agent version from VERSION file. */
    version?: string;
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
    /** Client platform for V2 tool filtering. */
    platform?: "windows" | "linux" | "macos";
    /** Agent version from VERSION file. */
    version?: string;
  };
}

export interface WSPromptMessage extends WSMessage {
  type: "prompt";
  payload: {
    prompt: string;
    context?: Record<string, any>;
    /** Prompt origin — "scheduled_task" for recurring scheduled tasks, undefined for user prompts */
    source?: string;
    /** Pre-classification hints from the local agent (runs on-device before sending) */
    hints?: {
      /** Local LLM detected multiple unrelated requests in the message */
      multiItem?: boolean;
      /** Suggested persona for routing (e.g., from scheduled tasks) */
      personaHint?: string;
    };
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
