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

const CHECK_INTERVAL_MS = 60_000;       // Check every 60s
const STUCK_THRESHOLD_MS = 180_000;     // 3min with no progress = stuck warning
const ABORT_THRESHOLD_MS = 300_000;     // 5min with no progress = abort
const MAX_STATUS_REQUESTS = 3;          // Max status injections before giving up

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

      // Track status changes
      if (agent.status === monitor.lastKnownStatus) {
        monitor.sameStatusCount++;
      } else {
        monitor.sameStatusCount = 0;
        monitor.lastKnownStatus = agent.status;
      }

      // Stuck detection: same status for too many checks
      if (monitor.sameStatusCount >= 3 && elapsed > STUCK_THRESHOLD_MS) {
        if (monitor.statusRequestCount < MAX_STATUS_REQUESTS) {
          // Inject status request
          monitor.statusRequestCount++;
          log.info("Supervisor: requesting status from stuck agent", {
            agentId: agent.id,
            topic: agent.topic,
            sameStatusCount: monitor.sameStatusCount,
          });

          this.options.onInjectMessage?.(
            agent.id,
            `⚠️ SUPERVISOR CHECK-IN: You've been running for ${Math.round(elapsed / 1000)}s. ` +
            `Report your current progress: what have you done, what's blocking you, and what remains? ` +
            `If you're stuck, try a different approach or call agent.escalate.`
          );

          this.options.onStatusReport?.({
            agentId: agent.id,
            topic: agent.topic,
            status: "stuck",
            message: `Agent "${agent.topic}" appears stuck (${Math.round(elapsed / 1000)}s elapsed, no progress). Requesting status.`,
            elapsedMs: elapsed,
          });
        } else if (elapsed > ABORT_THRESHOLD_MS) {
          // Too many status requests with no change — abort
          log.warn("Supervisor: aborting stuck agent", {
            agentId: agent.id,
            topic: agent.topic,
            elapsed,
          });

          this.options.onAbortAgent?.(agent.id, "No progress after multiple check-ins");
          this.options.onStatusReport?.({
            agentId: agent.id,
            topic: agent.topic,
            status: "aborted",
            message: `Agent "${agent.topic}" was stopped — no progress after ${Math.round(elapsed / 60_000)} minutes.`,
            elapsedMs: elapsed,
          });

          this.unwatch(agentId);
        }
      }

      monitor.lastCheckAt = now;
    }
  }
}
