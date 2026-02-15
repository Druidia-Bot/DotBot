/**
 * Workspace Types & Constants
 *
 * Core types for the agent workspace system.
 * Each spawned agent gets an isolated workspace directory on the client:
 *
 *   ~/.bot/agent-workspaces/
 *     agent_abc123/
 *       task.json          <- task metadata + status + conversation
 *       research/          <- research sub-agent output
 *       output/            <- agent's deliverables
 *       logs/
 *         tool-calls.jsonl <- append-only log of every tool call + result
 */

/** Base path for agent workspaces on the client. */
export const WORKSPACE_BASE = "~/.bot/agent-workspaces";

/** Agent IDs are "agent_" + 12-char nanoid (alphanumeric, dash, underscore). */
const SAFE_AGENT_ID = /^agent_[A-Za-z0-9_-]{8,24}$/;

export function assertSafeAgentId(agentId: string): void {
  if (!SAFE_AGENT_ID.test(agentId)) {
    throw new Error(`Invalid agentId: ${agentId}`);
  }
}

/** A tool call descriptor — sent to the local agent for execution. */
export interface WorkspaceCommand {
  toolId: string;
  args: Record<string, any>;
}

export interface AgentWorkspace {
  /** Agent ID this workspace belongs to */
  agentId: string;
  /** Full path to the workspace root */
  basePath: string;
  /** Path to the research sub-folder */
  researchPath: string;
  /** Path to the output sub-folder */
  outputPath: string;
  /** Path to the logs sub-folder */
  logsPath: string;
  /** When the workspace was created */
  createdAt: Date;
}

/**
 * Rich task.json — the heart of task persistence.
 * If a task.json exists in a workspace folder, the task is NOT complete.
 */
export interface TaskJson {
  // Identity
  taskId: string;
  topic: string;
  createdAt: string;

  // Status
  status: "running" | "paused" | "blocked" | "researching" | "failed";
  lastActiveAt: string;
  failureReason?: string;

  // Persona (written by receptionist/persona-writer)
  persona: {
    systemPrompt: string;
    role: string;
    temperature: number;
    maxIterations: number;
    modelTier: string;
  };

  // Tool scope
  selectedToolIds: string[];

  // Conversation history (isolated)
  conversation: Array<{
    role: "user" | "assistant" | "system";
    content: string;
    timestamp: string;
    toolCalls?: Array<{
      toolId: string;
      input: Record<string, unknown>;
      result: string;
    }>;
  }>;

  // Progress tracking
  progress: {
    stepsCompleted: string[];
    currentStep: string;
    estimatedRemaining?: string;
  };

  // Links
  parentAgentId?: string;
  childAgentIds?: string[];
  originalMessageIndices: number[];

  // Original conversation snapshot (what the persona-writer saw when spawning this agent)
  originalConversationSnapshot?: string[];
}
