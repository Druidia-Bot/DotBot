/**
 * Universal Tools
 *
 * Tools that work on all platforms including web (ALL platform).
 * These are typically server-executed tools that don't require local platform capabilities.
 */

import type { CoreToolDefinition } from "../core-registry.js";
import type { Platform } from "../../agents/tools.js";

const ALL: Platform[] = ["windows", "linux", "macos", "web"];

// ============================================
// UNIVERSAL TOOLS (Server-executed)
// ============================================

// Knowledge (server-executed ingest)
export const knowledgeUniversal: CoreToolDefinition[] = [
  { id: "knowledge.ingest", name: "ingest_knowledge", description: "Process a URL, local file, or archive into structured JSON knowledge using Gemini.", category: "knowledge", executor: "server", platforms: ALL, inputSchema: { type: "object", properties: { source: { type: "string" } }, required: ["source"] } },
];

// Scheduled Tasks (server-executed)
export const schedule: CoreToolDefinition[] = [
  { id: "schedule.create", name: "create_scheduled_task", description: "Create a recurring scheduled task (daily, weekly, hourly, or interval). Tasks persist on the server and run even when the client is offline.", category: "schedule", executor: "server", platforms: ALL, inputSchema: { type: "object", properties: { name: { type: "string", description: "Human-readable name for the task" }, prompt: { type: "string", description: "The prompt to execute on schedule" }, type: { type: "string", enum: ["daily", "weekly", "hourly", "interval"], description: "Schedule type" }, time: { type: "string", description: "HH:MM time for daily/weekly (e.g. '06:00', '14:30')" }, day_of_week: { type: "number", description: "0=Sunday..6=Saturday (for weekly)" }, interval_minutes: { type: "number", description: "Minutes between runs (for interval, min 5)" }, persona_hint: { type: "string", description: "Optional persona to use" }, timezone: { type: "string", description: "IANA timezone (e.g. 'America/New_York'). Defaults to UTC" }, priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] } }, required: ["name", "prompt", "type"] } },
  { id: "schedule.list", name: "list_scheduled_tasks", description: "List all recurring scheduled tasks for the current user.", category: "schedule", executor: "server", platforms: ALL, inputSchema: { type: "object", properties: { status: { type: "string", enum: ["active", "paused", "cancelled"], description: "Filter by status" } } }, annotations: { readOnlyHint: true } },
  { id: "schedule.cancel", name: "cancel_scheduled_task", description: "Permanently cancel a recurring scheduled task.", category: "schedule", executor: "server", platforms: ALL, inputSchema: { type: "object", properties: { id: { type: "string", description: "Task ID (rsched_...)" } }, required: ["id"] } },
  { id: "schedule.pause", name: "pause_scheduled_task", description: "Temporarily pause a recurring scheduled task.", category: "schedule", executor: "server", platforms: ALL, inputSchema: { type: "object", properties: { id: { type: "string", description: "Task ID (rsched_...)" } }, required: ["id"] } },
  { id: "schedule.resume", name: "resume_scheduled_task", description: "Resume a paused scheduled task. Resets failure count and recalculates next run.", category: "schedule", executor: "server", platforms: ALL, inputSchema: { type: "object", properties: { id: { type: "string", description: "Task ID (rsched_...)" } }, required: ["id"] } },
];

// Research (server-executed workspace management)
export const research: CoreToolDefinition[] = [
  {
    id: "research.save",
    name: "save_research_artifact",
    description: "Save research findings to workspace files. Creates detailed notes in workspace/research/ and executive summary in workspace/output/report.md. Use this for any research output (market analysis, competitive research, news summaries, etc.). Workspace persists for 24 hours after agent completion.",
    category: "research",
    executor: "server",
    platforms: ALL,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title for the research (e.g., 'LYFT Stock Analysis')" },
        type: { type: "string", enum: ["market-analysis", "news-summary", "general-research", "competitive-analysis"], description: "Type of research" },
        detailedNotes: { type: "string", description: "Full markdown content with all findings, data, analysis" },
        executiveSummary: { type: "string", description: "Brief 2-3 paragraph summary with key takeaways" },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags for categorization" },
        metadata: { type: "object", description: "Optional metadata (e.g., tickers, dates, sources)" }
      },
      required: ["title", "type", "detailedNotes", "executiveSummary"]
    },
    annotations: { destructiveHint: true }
  },
  {
    id: "research.list",
    name: "list_research_artifacts",
    description: "List all research files in your workspace. Use this at the START of research tasks to check if you've already researched this topic. Returns list of research files with titles, types, dates, and tags. Helps avoid duplicate work and build on previous findings.",
    category: "research",
    executor: "server",
    platforms: ALL,
    inputSchema: {
      type: "object",
      properties: {}
    },
    annotations: { readOnlyHint: true }
  },
];

/** All universal (ALL platforms) tools */
export const UNIVERSAL_TOOLS: CoreToolDefinition[] = [
  ...knowledgeUniversal,
  ...schedule,
  ...research,
];
