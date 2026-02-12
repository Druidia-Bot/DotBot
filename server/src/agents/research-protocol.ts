/**
 * Research Delegation Protocol — V2 Research Sub-Agents
 *
 * When a spawned agent needs to look something up, it can request
 * research via the `agent.request_research` synthetic tool. This module
 * handles creating and configuring research sub-agents.
 *
 * Flow:
 * 1. Agent calls agent.request_research({ query, depth, format })
 * 2. Tool loop catches it (like agent.escalate)
 * 3. This module creates an AgentTask configured for research
 * 4. Orchestrator spawns the research agent with its own tool set
 * 5. Research agent saves findings to the parent's workspace
 * 6. Parent agent is notified when research completes
 *
 * Research agents are optimized for speed:
 * - Use workhorse model (fast, cheap)
 * - Pre-configured with search + http + knowledge tools
 * - Structured output (JSON/markdown, not prose)
 * - Limited iteration budget based on depth
 */

import { createComponentLogger } from "../logging.js";
import type { AgentTask } from "./orchestrator.js";

const log = createComponentLogger("research");

// ============================================
// TYPES
// ============================================

export type ResearchDepth = "quick" | "moderate" | "thorough";
export type ResearchFormat = "plain_text" | "structured_json" | "markdown";

export interface ResearchRequest {
  /** ID of the agent requesting research */
  requestingAgentId: string;
  /** What to research */
  query: string;
  /** How deep to search */
  depth: ResearchDepth;
  /** Output format */
  format: ResearchFormat;
  /** Max minutes to spend (default: 5) */
  maxMinutes: number;
}

/** Iteration budgets by depth level */
const DEPTH_CONFIG: Record<ResearchDepth, { maxIterations: number; tools: string[] }> = {
  quick: {
    maxIterations: 5,
    tools: ["search.ddg_instant", "search.brave_search"],
  },
  moderate: {
    maxIterations: 15,
    tools: [
      "search.brave_search", "search.ddg_instant",
      "http.request", "http.render",
      "knowledge.search", "knowledge.list",
    ],
  },
  thorough: {
    maxIterations: 30,
    tools: [
      "search.brave_search", "search.ddg_instant",
      "http.request", "http.render",
      "knowledge.search", "knowledge.list", "knowledge.ingest",
      "filesystem.create_file", "filesystem.read_file",
    ],
  },
};

// ============================================
// RESEARCH AGENT CREATION
// ============================================

/**
 * Create an AgentTask configured for research.
 * Returns a task ready to be passed to the orchestrator for spawning.
 */
export function createResearchTask(request: ResearchRequest): AgentTask {
  const config = DEPTH_CONFIG[request.depth];

  const formatInstruction = request.format === "structured_json"
    ? "Save your findings as structured JSON. Each finding should have: source, data, confidence, timestamp."
    : request.format === "markdown"
      ? "Write your findings as clean markdown with headers, bullet points, and source links."
      : "Write your findings as clear, concise plain text with source references.";

  const systemPrompt = `You are a focused research agent. Your ONLY job is to find specific information and report it.

## Research Query
${request.query}

## Instructions
1. Search for the requested information using your tools
2. Verify findings from multiple sources when possible
3. ${formatInstruction}
4. Be CONCISE — report facts, not opinions
5. Include source URLs for every finding
6. If you can't find something, say so clearly — don't make up data

## Constraints
- Do NOT engage in conversation or pleasantries
- Do NOT provide analysis or recommendations unless specifically asked
- Do NOT exceed ${request.maxMinutes} minutes of research time
- Do NOT create files unless your depth level includes filesystem tools
- Report what you found and stop

## Success Criteria
You are DONE when you have:
- Found the requested information (or confirmed it's not available)
- Reported your findings with sources
- Provided a brief summary of confidence level

If you can't find the right tools, call agent.escalate.`;

  log.info("Creating research task", {
    requestingAgent: request.requestingAgentId,
    depth: request.depth,
    toolCount: config.tools.length,
    maxIterations: config.maxIterations,
  });

  return {
    task: `Research: ${request.query}`,
    topic: `Research for ${request.requestingAgentId}`,
    systemPrompt,
    selectedToolIds: config.tools,
    modelRole: "workhorse",
    relevantMessageIndices: [],
  };
}

/**
 * Parse a research request from tool call arguments.
 * Used by the tool loop when it catches agent.request_research.
 */
export function parseResearchRequest(
  agentId: string,
  args: Record<string, any>
): ResearchRequest {
  return {
    requestingAgentId: agentId,
    query: args.query || args.research_query || "",
    depth: (args.depth || "moderate") as ResearchDepth,
    format: (args.format || "markdown") as ResearchFormat,
    maxMinutes: args.max_minutes || args.maxMinutes || 5,
  };
}
