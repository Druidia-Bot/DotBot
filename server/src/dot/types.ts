/**
 * Dot — Types
 *
 * Interfaces for the Dot-first conversational layer.
 * Dot is the root-level assistant that converses with the user
 * and dispatches to the pipeline when real work is needed.
 */

import type { ILLMClient } from "#llm/types.js";

// ============================================
// DOT OPTIONS
// ============================================

export interface DotOptions {
  llm: ILLMClient;
  userId: string;
  deviceId: string;
  prompt: string;
  messageId: string;
  source: string;
  /** Stream callback — sends Dot's text to the user between tool calls. */
  onStream?: (text: string) => void;
}

// ============================================
// DOT PREPARED CONTEXT (output of pre-dot phase)
// ============================================

/** Everything the pre-dot phase produces — passed to runDot() and used for thread saving. */
export interface DotPreparedContext {
  /** The resolved/restated prompt (context-aware rewrite of the user's raw input). */
  resolvedPrompt: string;
  /** Active thread ID from context builder. */
  threadId: string;
  /** @internal Pre-dot state consumed by runDot — opaque to callers. */
  _internal: unknown;
}

// ============================================
// DOT RESULT
// ============================================

export interface DotResult {
  /** Dot's final text response to the user. */
  response: string;
  /** Whether Dot dispatched to the full pipeline. */
  dispatched: boolean;
  /** Active thread ID from context builder. */
  threadId: string;
  /** Dispatch details (only if dispatched). */
  dispatch?: {
    agentId?: string;
    workspacePath?: string;
    success?: boolean;
    executionResponse?: string;
  };
}

// ============================================
// TOOL CATEGORIES DOT CAN USE (proxied to local agent)
// ============================================

/** Categories from the tool manifest that Dot can call directly. */
export const DOT_PROXY_CATEGORIES = new Set([
  "search",      // search.brave, search.files
  "system",      // system.update, system.restart
  "http",        // http.get, http.post
  "reminder",    // reminder.set, reminder.list, reminder.cancel
  "filesystem",  // create_file, edit_file, read_file, list_directory, etc.
  "shell",       // shell.execute
  "secrets",     // secrets.prompt_user — secure API key input
  "tools",       // tools.list_tools, tools.save_tool, tools.delete_tool
  "discord",     // discord.gateway, discord.send_message, discord.full_setup, etc.
  "personas",    // personas.create, personas.list, personas.read
  "memory",      // memory.create_model, memory.save_message, memory.search, etc.
  "imagegen",    // imagegen.generate, imagegen.edit — image generation & editing
]);
