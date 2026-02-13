/**
 * Agent Workspaces — V2 Per-Agent Temporary Storage
 *
 * Each spawned agent gets an isolated workspace directory on the client
 * for intermediate files, research results, task artifacts, and execution logs.
 *
 * Structure:
 *   ~/.bot/agent-workspaces/
 *     agent_abc123/
 *       task.json          <- task metadata + status + conversation
 *       research/          <- research sub-agent output
 *       output/            <- agent's deliverables
 *       logs/
 *         tool-calls.jsonl <- append-only log of every tool call + result
 *
 * The server doesn't manage the filesystem directly — it sends
 * workspace commands to the local agent via the existing tool protocol.
 * This module defines the workspace model and generates tool call descriptors.
 *
 * Lifecycle:
 * - Created when an agent is spawned
 * - task.json exists = task is NOT complete (simple rule)
 * - On completion: agent deletes task.json; folder cleaned up after 1 hour
 * - On reconnect: scan for folders with task.json → offer resumption
 */

import { createComponentLogger } from "../logging.js";

const log = createComponentLogger("workspace");

// ============================================
// CLEANUP SCHEDULER
// ============================================

/** Track completed workspaces for cleanup */
const completedWorkspaces = new Map<string, { agentId: string; completedAt: Date }>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/** Cleanup interval: check every 10 minutes */
const CLEANUP_CHECK_INTERVAL_MS = 10 * 60 * 1000;

/** Delete workspace 24 hours after task completion */
const CLEANUP_DELAY_MS = 24 * 60 * 60 * 1000;

/** Auto-fail blocked tasks after 7 days of inactivity */
const STALE_BLOCKED_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

// ============================================
// TYPES
// ============================================

/** Base path for agent workspaces on the client. */
const WORKSPACE_BASE = "~/.bot/agent-workspaces";

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

/** Single entry in tool-calls.jsonl */
export interface ToolCallLogEntry {
  ts: string;
  tool: string;
  input: Record<string, unknown>;
  result: string;
  durationMs: number;
}

/** Single entry in execution.jsonl — per-agent execution intelligence */
export interface ExecutionJournalEntry {
  ts: string;
  type: "model_selected" | "llm_call" | "tool_call" | "supervisor" | "summarization" | "lifecycle";
  agentId: string;

  /** Model selection decision */
  model?: { role: string; provider: string; model: string; reason: string };

  /** LLM call metadata */
  llm?: { provider: string; model: string; inputTokens?: number; outputTokens?: number; durationMs: number };

  /** Tool execution metadata */
  tool?: { toolId: string; durationMs: number; resultChars: number; success: boolean; summarized?: boolean };

  /** Supervisor event */
  supervisor?: { status: string; action: string; message: string; timeSinceActivityMs?: number };

  /** Tandem pipeline summarization event */
  summarization?: { toolId: string; originalChars: number; summaryChars: number; provider: string; durationMs: number };

  /** Agent lifecycle event */
  lifecycle?: { event: "started" | "completed" | "failed" | "escalated" | "blocked"; detail?: string };
}

// ============================================
// VALIDATION
// ============================================

/** Agent IDs are "agent_" + 12-char nanoid (alphanumeric, dash, underscore). */
const SAFE_AGENT_ID = /^agent_[A-Za-z0-9_-]{8,24}$/;

function assertSafeAgentId(agentId: string): void {
  if (!SAFE_AGENT_ID.test(agentId)) {
    throw new Error(`Invalid agentId: ${agentId}`);
  }
}

// ============================================
// WORKSPACE MANAGEMENT
// ============================================

/**
 * Create a workspace definition for an agent.
 * Returns the workspace paths and the tool commands needed to create
 * the directory structure on the client.
 */
export function createWorkspace(agentId: string): {
  workspace: AgentWorkspace;
  setupCommands: WorkspaceCommand[];
} {
  assertSafeAgentId(agentId);
  const basePath = `${WORKSPACE_BASE}/${agentId}`;
  const researchPath = `${basePath}/research`;
  const outputPath = `${basePath}/output`;
  const logsPath = `${basePath}/logs`;

  const workspace: AgentWorkspace = {
    agentId,
    basePath,
    researchPath,
    outputPath,
    logsPath,
    createdAt: new Date(),
  };

  const setupCommands: WorkspaceCommand[] = [
    { toolId: "directory.create", args: { path: basePath, recursive: true } },
    { toolId: "directory.create", args: { path: researchPath, recursive: true } },
    { toolId: "directory.create", args: { path: outputPath, recursive: true } },
    { toolId: "directory.create", args: { path: logsPath, recursive: true } },
  ];

  log.info("Workspace created", { agentId, basePath });
  return { workspace, setupCommands };
}

// ============================================
// TASK.JSON OPERATIONS
// ============================================

/**
 * Generate a command to write the initial task.json to the workspace.
 */
export function saveTaskJson(
  workspace: AgentWorkspace,
  task: TaskJson
): WorkspaceCommand {
  return {
    toolId: "filesystem.create_file",
    args: {
      path: `${workspace.basePath}/task.json`,
      content: JSON.stringify(task, null, 2),
    },
  };
}

/**
 * Generate a command to update task.json status and progress.
 * Reads the file, patches the fields, writes it back — but since
 * the server can't read client files directly, we send the full
 * updated object. The caller is responsible for maintaining the
 * current TaskJson state in memory.
 */
export function updateTaskJson(
  workspace: AgentWorkspace,
  task: TaskJson
): WorkspaceCommand {
  task.lastActiveAt = new Date().toISOString();
  return {
    toolId: "filesystem.create_file",
    args: {
      path: `${workspace.basePath}/task.json`,
      content: JSON.stringify(task, null, 2),
    },
  };
}

/**
 * Generate a command to append a conversation entry to task.json.
 * Since the server can't read client files directly, this requires
 * the full TaskJson to be passed in with the new entry appended.
 */
export function appendConversationEntry(
  workspace: AgentWorkspace,
  task: TaskJson,
  entry: TaskJson["conversation"][number]
): WorkspaceCommand {
  task.conversation.push(entry);
  task.lastActiveAt = new Date().toISOString();
  return {
    toolId: "filesystem.create_file",
    args: {
      path: `${workspace.basePath}/task.json`,
      content: JSON.stringify(task, null, 2),
    },
  };
}

/**
 * Generate a command to delete task.json — marks the task as complete.
 * The workspace folder stays for cleanup later.
 */
export function completeTask(workspace: AgentWorkspace): WorkspaceCommand {
  return {
    toolId: "filesystem.delete_file",
    args: { path: `${workspace.basePath}/task.json` },
  };
}

// ============================================
// TOOL CALL LOGGING
// ============================================

/**
 * Generate a command to append a tool call entry to logs/tool-calls.jsonl.
 * One JSON object per line, append-only.
 */
export function appendToolCallLog(
  workspace: AgentWorkspace,
  entry: ToolCallLogEntry
): WorkspaceCommand {
  const line = JSON.stringify(entry);
  return {
    toolId: "filesystem.append_file",
    args: {
      path: `${workspace.logsPath}/tool-calls.jsonl`,
      content: line + "\n",
    },
  };
}

/**
 * Generate a command to write the full conversation log to logs/conversation.json.
 * Single write (not append) — overwrites any previous conversation log.
 * Contains the complete system → user → assistant → tool message sequence.
 */
export function saveConversationLog(
  workspace: AgentWorkspace,
  messages: Array<{ role: string; content: string; toolCalls?: any[] }>
): WorkspaceCommand {
  return {
    toolId: "filesystem.create_file",
    args: {
      path: `${workspace.logsPath}/conversation.json`,
      content: JSON.stringify(messages, null, 2),
    },
  };
}

/**
 * Generate a command to append an execution journal entry to logs/execution.jsonl.
 * One JSON object per line, append-only. Contains model selection, LLM call timing,
 * tool execution timing, supervisor events, and lifecycle events — everything
 * the agent needs for self-reflection and the user needs for debugging.
 */
export function appendExecutionJournal(
  workspace: AgentWorkspace,
  entry: ExecutionJournalEntry
): WorkspaceCommand {
  const line = JSON.stringify(entry);
  return {
    toolId: "filesystem.append_file",
    args: {
      path: `${workspace.logsPath}/execution.jsonl`,
      content: line + "\n",
    },
  };
}

// ============================================
// OUTPUT & RESEARCH FILES
// ============================================

/**
 * Generate a command to save an output file to the workspace.
 */
export function saveOutputFile(
  workspace: AgentWorkspace,
  filename: string,
  content: string
): WorkspaceCommand {
  return {
    toolId: "filesystem.create_file",
    args: {
      path: `${workspace.outputPath}/${filename}`,
      content,
    },
  };
}

/**
 * Generate a command to save research output to the workspace.
 */
export function saveResearchOutput(
  workspace: AgentWorkspace,
  filename: string,
  content: string
): WorkspaceCommand {
  return {
    toolId: "filesystem.create_file",
    args: {
      path: `${workspace.researchPath}/${filename}`,
      content,
    },
  };
}

/**
 * Generate a command to write research findings with metadata.
 * Creates a structured JSON file with query, findings, sources, and timestamp.
 */
export function writeResearchFindings(
  agentId: string,
  data: {
    query: string;
    findings: string;
    sources: string[];
    completedAt: Date;
  }
): WorkspaceCommand {
  assertSafeAgentId(agentId);

  const timestamp = data.completedAt.toISOString().replace(/[:.]/g, "-");
  const filename = `research-${timestamp}.json`;

  const researchData = {
    query: data.query,
    findings: data.findings,
    sources: data.sources,
    completedAt: data.completedAt.toISOString(),
  };

  return {
    toolId: "filesystem.create_file",
    args: {
      path: `${WORKSPACE_BASE}/${agentId}/research/${filename}`,
      content: JSON.stringify(researchData, null, 2),
    },
  };
}

// ============================================
// TASK RESUMPTION
// ============================================

/**
 * Generate the command to list workspace directories on the client.
 * The local agent executes this and returns the folder list.
 * The caller then checks each folder for task.json to find incomplete tasks.
 */
export function listWorkspaceFolders(): WorkspaceCommand {
  return {
    toolId: "directory.list",
    args: { path: WORKSPACE_BASE },
  };
}

/**
 * Generate the command to read a task.json from a specific agent workspace.
 */
export function readTaskJson(agentId: string): WorkspaceCommand {
  assertSafeAgentId(agentId);
  return {
    toolId: "filesystem.read_file",
    args: { path: `${WORKSPACE_BASE}/${agentId}/task.json` },
  };
}

/**
 * Given a list of TaskJson objects from incomplete workspaces,
 * categorize them for the resumption prompt.
 */
export function categorizeIncompleteTasks(tasks: TaskJson[]): {
  resumable: TaskJson[];
  failed: TaskJson[];
  blocked: TaskJson[];
} {
  const resumable: TaskJson[] = [];
  const failed: TaskJson[] = [];
  const blocked: TaskJson[] = [];

  for (const task of tasks) {
    if (task.status === "failed") {
      failed.push(task);
    } else if (task.status === "blocked") {
      blocked.push(task);
    } else {
      // running, paused, researching → all resumable
      resumable.push(task);
    }
  }

  return { resumable, failed, blocked };
}

// ============================================
// CLEANUP
// ============================================

/**
 * Generate cleanup command for a workspace.
 * Removes the entire workspace directory.
 */
export function cleanupWorkspace(agentId: string): WorkspaceCommand {
  assertSafeAgentId(agentId);
  return {
    toolId: "directory.delete",
    args: {
      path: `${WORKSPACE_BASE}/${agentId}`,
      recursive: true,
    },
  };
}

/**
 * Get the workspace base path for a given agent.
 */
export function getWorkspacePath(agentId: string): string {
  assertSafeAgentId(agentId);
  return `${WORKSPACE_BASE}/${agentId}`;
}

// ============================================
// CLEANUP SCHEDULER
// ============================================

/** Optional callback to execute cleanup commands */
let executeCleanupCallback: ((cmd: WorkspaceCommand) => Promise<void>) | null = null;

/**
 * Set the callback for executing cleanup commands.
 * Should be called on server startup.
 */
export function setCleanupExecutor(executor: (cmd: WorkspaceCommand) => Promise<void>): void {
  executeCleanupCallback = executor;
}

/**
 * Schedule a workspace for cleanup after 1 hour.
 * Called when an agent completes and task.json is deleted.
 */
export function scheduleWorkspaceCleanup(agentId: string): void {
  assertSafeAgentId(agentId);
  completedWorkspaces.set(agentId, {
    agentId,
    completedAt: new Date(),
  });

  // Start cleanup timer if not running
  if (!cleanupTimer) {
    cleanupTimer = setInterval(() => {
      const commands = runCleanupCycle();
      // Execute cleanup commands if callback is set
      if (executeCleanupCallback && commands.length > 0) {
        for (const cmd of commands) {
          executeCleanupCallback(cmd).catch((err) => {
            log.error("Failed to execute cleanup command", { error: err, agentId: cmd.args?.path });
          });
        }
      }
    }, CLEANUP_CHECK_INTERVAL_MS);
    if (cleanupTimer.unref) cleanupTimer.unref(); // Don't keep process alive
    log.info("Workspace cleanup scheduler started");
  }

  log.info("Workspace scheduled for cleanup in 1 hour", { agentId });
}

/**
 * Run a cleanup cycle: delete workspaces older than 1 hour.
 * Returns cleanup commands for the client to execute.
 */
export function runCleanupCycle(): WorkspaceCommand[] {
  const now = Date.now();
  const commands: WorkspaceCommand[] = [];

  for (const [agentId, { completedAt }] of completedWorkspaces) {
    const age = now - completedAt.getTime();
    if (age >= CLEANUP_DELAY_MS) {
      commands.push(cleanupWorkspace(agentId));
      completedWorkspaces.delete(agentId);
      log.info("Workspace cleanup command generated", { agentId, ageMinutes: Math.round(age / 60_000) });
    }
  }

  // Stop timer if no more workspaces to clean
  if (completedWorkspaces.size === 0 && cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    log.info("Workspace cleanup scheduler stopped (no workspaces)");
  }

  return commands;
}

/**
 * Stop the workspace cleanup scheduler.
 * Called on server shutdown.
 */
export function stopWorkspaceCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    log.info("Workspace cleanup scheduler stopped");
  }
  completedWorkspaces.clear();
}

/**
 * Get pending cleanup workspaces (for debugging/monitoring).
 */
export function getPendingCleanups(): Array<{ agentId: string; completedAt: Date; remainingMs: number }> {
  const now = Date.now();
  return Array.from(completedWorkspaces.values()).map(w => ({
    agentId: w.agentId,
    completedAt: w.completedAt,
    remainingMs: Math.max(0, CLEANUP_DELAY_MS - (now - w.completedAt.getTime())),
  }));
}

// ============================================
// STALE BLOCKED TASK CLEANUP
// ============================================

/**
 * Check if a blocked task is stale (inactive for > 7 days).
 * A task is considered active if:
 * - The agent is running (not blocked)
 * - The agent received a user message (lastActiveAt updated)
 */
export function isTaskStale(task: TaskJson): boolean {
  if (task.status !== "blocked") return false;

  const lastActive = new Date(task.lastActiveAt);
  const now = Date.now();
  const inactiveMs = now - lastActive.getTime();

  return inactiveMs >= STALE_BLOCKED_TIMEOUT_MS;
}

/**
 * Generate a command to mark a task as failed due to staleness.
 * This updates the task.json with failure reason and failed status,
 * then schedules it for deletion after 24 hours.
 */
export function failStaleTask(
  workspace: AgentWorkspace,
  task: TaskJson
): WorkspaceCommand {
  task.status = "failed";
  task.failureReason = "Task blocked for over 7 days with no activity. Auto-failed.";
  task.lastActiveAt = new Date().toISOString();

  return {
    toolId: "filesystem.create_file",
    args: {
      path: `${workspace.basePath}/task.json`,
      content: JSON.stringify(task, null, 2),
    },
  };
}
