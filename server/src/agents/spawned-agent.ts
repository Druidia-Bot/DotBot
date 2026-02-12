/**
 * Spawned Agent — V2 Isolated Execution Context
 *
 * Each spawned agent has its own conversation history, selected tools,
 * and dynamic persona. The orchestrator creates these per-task.
 *
 * This is the core data model for V2 conversation isolation:
 * - Each agent sees ONLY messages relevant to its task
 * - Each agent gets ONLY the tools it needs (not 140+)
 * - Each agent has a custom-written persona (not a static .md file)
 */

import { nanoid } from "nanoid";

// ============================================
// TYPES
// ============================================

export type AgentStatus = "pending" | "running" | "blocked" | "completed" | "failed";

export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** For tool messages: the tool_call_id this result belongs to */
  toolCallId?: string;
}

export interface SpawnedAgentConfig {
  /** What this agent should accomplish */
  task: string;
  /** Short topic label for display (e.g., "Day with kids", "Business proposal") */
  topic: string;
  /** Custom system prompt written by the receptionist for this specific task */
  systemPrompt: string;
  /** Specific tool IDs this agent can use (from compact catalog) */
  selectedToolIds: string[];
  /** Relevant message indices from the main feed (conversation isolation) */
  relevantMessageIndices?: number[];
  /** Model role hint for this agent */
  modelRole?: "workhorse" | "deep_context" | "architect" | "gui_fast";
}

// ============================================
// SPAWNED AGENT
// ============================================

export class SpawnedAgent {
  readonly id: string;
  readonly task: string;
  readonly topic: string;
  readonly systemPrompt: string;
  selectedToolIds: string[]; // Mutable - can be expanded at runtime via agent.request_tools
  readonly relevantMessageIndices: readonly number[];
  readonly modelRole?: "workhorse" | "deep_context" | "architect" | "gui_fast";
  readonly createdAt: Date;

  status: AgentStatus = "pending";
  response: string = "";
  error?: string;

  /** Isolated conversation history for this agent */
  private conversation: AgentMessage[] = [];

  constructor(config: SpawnedAgentConfig) {
    this.id = `agent_${nanoid(12)}`;
    this.task = config.task;
    this.topic = config.topic;
    this.systemPrompt = config.systemPrompt;
    this.selectedToolIds = config.selectedToolIds;
    this.relevantMessageIndices = config.relevantMessageIndices || [];
    this.modelRole = config.modelRole;
    this.createdAt = new Date();
  }

  /** Start the agent. */
  start(): void {
    this.status = "running";
  }

  /** Mark agent as completed with a response. */
  complete(response: string): void {
    this.status = "completed";
    this.response = response;
  }

  /** Mark agent as failed with an error. */
  fail(error: string): void {
    this.status = "failed";
    this.error = error;
  }

  /** Mark agent as blocked (waiting for user input). */
  block(): void {
    this.status = "blocked";
  }

  /** Add a message to this agent's isolated conversation. */
  addMessage(msg: AgentMessage): void {
    this.conversation.push(msg);
  }

  /** Get this agent's full isolated conversation. */
  getConversation(): AgentMessage[] {
    return [...this.conversation];
  }

  /** Get a compact status summary for the supervisor/user. */
  getSummary(): string {
    return `[${this.status.toUpperCase()}] ${this.topic}: ${this.task.substring(0, 100)}`;
  }
}
