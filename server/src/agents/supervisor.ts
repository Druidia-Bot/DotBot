/**
 * Agent Supervisor — V2 Periodic Check-in System
 *
 * Monitors active spawned agents and provides status updates to the user.
 * Replaces the V1 watchdog with a simpler, more useful approach:
 *
 * - Checks each active agent on a configurable interval
 * - Detects stuck agents (no tool calls in N minutes, same status repeated)
 * - Injects status request messages into agent conversations
 * - Reports agent progress to the user via the main feed
 * - Can request abort/restart for hopelessly stuck agents
 *
 * The supervisor does NOT use its own LLM calls. It reads agent state
 * and injects messages — the agent's own LLM call handles the response.
 */

import { createComponentLogger } from "../logging.js";
import type { SpawnedAgent } from "./spawned-agent.js";

const log = createComponentLogger("supervisor");

// ============================================
// CONFIG
// ============================================

const CHECK_INTERVAL_MS = 30_000;       // Check every 30s
const ZERO_PROGRESS_ABORT_MS = 60_000;  // 1min with zero conversation messages = pre-tool-loop hang
const MAX_STATUS_REQUESTS = 3;          // Max status injections before giving up

// Model-aware thresholds — slow models (architect/Claude Opus) get more time
const STUCK_THRESHOLD_MS: Record<string, number> = {
  architect: 300_000,    // 5min — Opus can take 60-120s per response
  deep_context: 240_000, // 4min — Gemini pro with large context
  workhorse: 120_000,    // 2min — fast models (DeepSeek V3)
  gui_fast: 90_000,      // 1.5min — quick UI tasks
  default: 120_000,
};
const ABORT_THRESHOLD_MS: Record<string, number> = {
  architect: 480_000,    // 8min
  deep_context: 360_000, // 6min
  workhorse: 240_000,    // 4min
  gui_fast: 150_000,     // 2.5min
  default: 240_000,
};

// ============================================
// TYPES
// ============================================

export interface SupervisorOptions {
  /** Callback to inject a system message into an agent's tool loop */
  onInjectMessage?: (agentId: string, message: string) => void;
  /** Callback to report agent status to the user via main feed */
  onStatusReport?: (report: AgentStatusReport) => void;
  /** Callback to abort a stuck agent */
  onAbortAgent?: (agentId: string, reason: string) => void;
}

export interface AgentStatusReport {
  agentId: string;
  topic: string;
  status: "progressing" | "slow" | "stuck" | "aborted";
  message: string;
  elapsedMs: number;
}

interface AgentMonitorState {
  agent: SpawnedAgent;
  lastCheckAt: number;
  statusRequestCount: number;
  lastKnownStatus: string;
  sameStatusCount: number;
  lastKnownConversationLength: number;
  lastKnownToolCallCount: number;
  lastKnownToolActivityAt: number;
}

// ============================================
// SUPERVISOR
// ============================================

export class AgentSupervisor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private monitors = new Map<string, AgentMonitorState>();
  private options: SupervisorOptions;

  constructor(options: SupervisorOptions = {}) {
    this.options = options;
  }

  /** Start monitoring a set of agents. Can be called multiple times to add agents. */
  watch(agents: SpawnedAgent[]): void {
    for (const agent of agents) {
      if (!this.monitors.has(agent.id)) {
        this.monitors.set(agent.id, {
          agent,
          lastCheckAt: Date.now(),
          statusRequestCount: 0,
          lastKnownStatus: agent.status,
          sameStatusCount: 0,
          lastKnownConversationLength: 0,
          lastKnownToolCallCount: 0,
          lastKnownToolActivityAt: 0,
        });
      }
    }

    // Start timer if not running
    if (!this.timer && this.monitors.size > 0) {
      this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
      if (this.timer.unref) this.timer.unref();
      log.info("Supervisor started", { agentCount: this.monitors.size });
    }
  }

  /** Stop monitoring all agents. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.monitors.clear();
    log.info("Supervisor stopped");
  }

  /** Remove a completed/failed agent from monitoring. */
  unwatch(agentId: string): void {
    this.monitors.delete(agentId);
    if (this.monitors.size === 0) {
      this.stop();
    }
  }

  /** Run a single check cycle across all monitored agents. */
  private check(): void {
    const now = Date.now();

    for (const [agentId, monitor] of this.monitors) {
      const agent = monitor.agent;

      // Skip completed/failed agents
      if (agent.status === "completed" || agent.status === "failed") {
        this.unwatch(agentId);
        continue;
      }

      // Skip blocked agents (waiting for user input — not stuck)
      if (agent.status === "blocked") continue;

      const elapsed = now - agent.createdAt.getTime();

      // Track progress via BOTH conversation growth AND tool loop activity.
      // The tool loop doesn't write to agent.conversation — it maintains its own
      // internal messages array. So we also check agent.lastToolActivityAt and
      // agent.toolCallCount which the tool loop updates on each iteration/tool call.
      const conversationLength = agent.getConversation().length;
      const conversationGrew = conversationLength > monitor.lastKnownConversationLength;
      monitor.lastKnownConversationLength = conversationLength;

      const toolCallCount = agent.toolCallCount;
      const toolCallsGrew = toolCallCount > monitor.lastKnownToolCallCount;
      monitor.lastKnownToolCallCount = toolCallCount;

      const toolActivityChanged = agent.lastToolActivityAt > monitor.lastKnownToolActivityAt;
      monitor.lastKnownToolActivityAt = agent.lastToolActivityAt;

      // Progress = conversation grew OR tool calls increased OR tool loop had recent activity
      const progressMade = conversationGrew || toolCallsGrew || toolActivityChanged;

      // Track status changes
      if (agent.status === monitor.lastKnownStatus && !progressMade) {
        monitor.sameStatusCount++;
      } else {
        monitor.sameStatusCount = 0;
        monitor.statusRequestCount = 0; // Reset status requests when progress resumes
        monitor.lastKnownStatus = agent.status;
      }

      // Fast abort: agent has zero conversation messages after 1 min AND tool loop hasn't started
      // = pre-tool-loop hang (workspace setup deadlock, LLM connection failure, etc.)
      if (conversationLength === 0 && !agent.toolLoopStarted && elapsed > ZERO_PROGRESS_ABORT_MS) {
        log.warn("Supervisor: aborting agent with zero progress (pre-tool-loop hang)", {
          agentId: agent.id,
          topic: agent.topic,
          elapsed,
        });

        this.options.onAbortAgent?.(agent.id, "Zero progress — agent never started tool loop");
        this.options.onStatusReport?.({
          agentId: agent.id,
          topic: agent.topic,
          status: "aborted",
          message: `Agent "${agent.topic}" was stopped — failed to start after ${Math.round(elapsed / 1000)}s.`,
          elapsedMs: elapsed,
        });

        this.unwatch(agentId);
        continue;
      }

      // Model-aware thresholds — slow models get more time
      const modelRole = agent.modelRole || "default";
      const stuckThreshold = STUCK_THRESHOLD_MS[modelRole] ?? STUCK_THRESHOLD_MS.default;
      const abortThreshold = ABORT_THRESHOLD_MS[modelRole] ?? ABORT_THRESHOLD_MS.default;

      // Also check time since last tool activity (more accurate than total elapsed)
      const timeSinceActivity = agent.lastToolActivityAt > 0
        ? now - agent.lastToolActivityAt
        : elapsed; // If no activity yet, use total elapsed

      // Stuck detection: no progress for too many checks AND exceeded model-specific threshold
      if (monitor.sameStatusCount >= 3 && timeSinceActivity > stuckThreshold) {
        if (monitor.statusRequestCount < MAX_STATUS_REQUESTS) {
          // Inject status request
          monitor.statusRequestCount++;
          log.info("Supervisor: requesting status from stuck agent", {
            agentId: agent.id,
            topic: agent.topic,
            sameStatusCount: monitor.sameStatusCount,
            modelRole,
            timeSinceActivity: Math.round(timeSinceActivity / 1000),
          });

          this.options.onInjectMessage?.(
            agent.id,
            `⚠️ SUPERVISOR CHECK-IN: You've been running for ${Math.round(elapsed / 1000)}s ` +
            `(${Math.round(timeSinceActivity / 1000)}s since last activity). ` +
            `Report your current progress: what have you done, what's blocking you, and what remains? ` +
            `If you're stuck, try a different approach or call agent.escalate.`
          );

          this.options.onStatusReport?.({
            agentId: agent.id,
            topic: agent.topic,
            status: "stuck",
            message: `Agent "${agent.topic}" appears stuck (${Math.round(timeSinceActivity / 1000)}s since last activity). Requesting status.`,
            elapsedMs: elapsed,
          });
        } else if (timeSinceActivity > abortThreshold) {
          // Too many status requests with no change — abort
          log.warn("Supervisor: aborting stuck agent", {
            agentId: agent.id,
            topic: agent.topic,
            elapsed,
            timeSinceActivity: Math.round(timeSinceActivity / 1000),
            modelRole,
          });

          this.options.onAbortAgent?.(agent.id, "No progress after multiple check-ins");
          this.options.onStatusReport?.({
            agentId: agent.id,
            topic: agent.topic,
            status: "aborted",
            message: `Agent "${agent.topic}" was stopped — no progress after ${Math.round(timeSinceActivity / 60_000)} minutes.`,
            elapsedMs: elapsed,
          });

          this.unwatch(agentId);
        }
      }

      monitor.lastCheckAt = now;
    }
  }
}
