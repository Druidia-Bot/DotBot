/**
 * Message Router — V2 Conversation Isolation
 *
 * Tracks which messages in the main conversation feed belong to which
 * spawned agent. When the receptionist decomposes a user message into
 * multiple tasks, each task's agent only sees the messages relevant to it.
 *
 * This solves the V1 problem where an agent working on "day with kids"
 * could see messages about "business proposal" and get confused.
 */

import type { SpawnedAgent } from "./spawned-agent.js";

// ============================================
// TYPES
// ============================================

export interface MessageAssignment {
  /** Which agent this message belongs to */
  agentId: string;
  /** Topic label for display */
  topic: string;
}

export interface RoutedMessage {
  /** Index in the main conversation feed */
  index: number;
  role: "user" | "assistant";
  content: string;
  /** Which agent(s) this message is assigned to */
  assignments: MessageAssignment[];
}

// ============================================
// MESSAGE ROUTER
// ============================================

export class MessageRouter {
  /** Maps main-feed message index → agent assignments */
  private assignments = new Map<number, MessageAssignment[]>();
  /** Active agents keyed by ID */
  private agents = new Map<string, SpawnedAgent>();

  /** Register a spawned agent with the router. */
  registerAgent(agent: SpawnedAgent): void {
    this.agents.set(agent.id, agent);
  }

  /** Assign a main-feed message to one or more agents. */
  assignMessage(messageIndex: number, agentId: string, topic: string): void {
    const existing = this.assignments.get(messageIndex) || [];
    existing.push({ agentId, topic });
    this.assignments.set(messageIndex, existing);
  }

  /**
   * Get the messages that a specific agent should see.
   * Returns only messages assigned to this agent, in order.
   */
  getMessagesForAgent(
    agentId: string,
    allMessages: { role: "user" | "assistant"; content: string }[]
  ): { role: "user" | "assistant"; content: string }[] {
    const result: { role: "user" | "assistant"; content: string }[] = [];
    for (let i = 0; i < allMessages.length; i++) {
      const assignments = this.assignments.get(i);
      if (assignments && assignments.some(a => a.agentId === agentId)) {
        result.push(allMessages[i]);
      }
    }
    return result;
  }

  /** Get all assignments for a message index. */
  getAssignments(messageIndex: number): MessageAssignment[] {
    return this.assignments.get(messageIndex) || [];
  }

  /** Get all registered agents. */
  getAgents(): SpawnedAgent[] {
    return Array.from(this.agents.values());
  }

  /** Get a specific agent by ID. */
  getAgent(agentId: string): SpawnedAgent | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Find the most likely agent for an unassigned follow-up message.
   * Uses keyword overlap scoring between the message and each agent's topic.
   * Returns undefined if no active agents or no good match.
   */
  findBestAgentForMessage(
    message: string,
    activeOnly: boolean = true
  ): SpawnedAgent | undefined {
    const agents = Array.from(this.agents.values());
    const candidates = activeOnly
      ? agents.filter(a => a.status === "running" || a.status === "blocked")
      : agents;

    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0];

    // Score each candidate by keyword overlap with the message
    const msgWords = new Set(
      message.toLowerCase().split(/\s+/).filter(w => w.length > 2)
    );

    let bestAgent: SpawnedAgent | undefined;
    let bestScore = 0;

    for (const agent of candidates) {
      const topicWords = agent.topic.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const taskWords = agent.task.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const allAgentWords = [...topicWords, ...taskWords];

      let score = 0;
      for (const word of allAgentWords) {
        if (msgWords.has(word)) score++;
      }

      // Bonus for most recently active (recency bias)
      score += 0.1;

      if (score > bestScore) {
        bestScore = score;
        bestAgent = agent;
      }
    }

    // If no keywords matched at all (only the 0.1 recency bias)...
    if (bestScore <= 0.1) {
      // For active-only mode: fall back to most recent agent (user is likely talking to it)
      // For all-agents mode: don't guess — no keyword overlap means it's probably a new topic
      if (activeOnly) {
        return candidates.sort((a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime()
        )[0];
      }
      return undefined;
    }

    return bestAgent;
  }

  /** Get all active (non-completed, non-failed) agents. */
  getActiveAgents(): SpawnedAgent[] {
    return Array.from(this.agents.values()).filter(
      a => a.status === "running" || a.status === "blocked" || a.status === "pending"
    );
  }

  /** Get agent topics as a compact string for the receptionist. */
  getActiveAgentSummary(): string {
    const active = this.getActiveAgents();
    if (active.length === 0) return "";
    return active
      .map(a => `- [${a.id}] "${a.topic}" (${a.status})`)
      .join("\n");
  }

  /** Clear all assignments and agents (session reset). */
  clear(): void {
    this.assignments.clear();
    this.agents.clear();
  }
}
