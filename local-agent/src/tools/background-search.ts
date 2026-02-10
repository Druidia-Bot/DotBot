/**
 * Background Search Manager
 *
 * Runs long-running searches asynchronously and stores results for polling.
 * The LLM starts a search with search.background and checks results with
 * search.check_results — no auto-injection, explicit polling only.
 */

import { nanoid } from "nanoid";
import { execFile } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import { resolve, join } from "path";
import * as os from "os";

const execFileAsync = promisify(execFile);

// ============================================
// TYPES
// ============================================

export interface BackgroundSearchTask {
  id: string;
  type: "file_content" | "deep_memory" | "archived_threads";
  query: string;
  status: "running" | "done" | "error";
  startedAt: number;
  completedAt?: number;
  results?: string;
  error?: string;
  resultCount?: number;
}

// ============================================
// TASK STORE (in-memory, ephemeral)
// ============================================

const tasks = new Map<string, BackgroundSearchTask>();
const MAX_TASKS = 50;
const TASK_TTL_MS = 30 * 60 * 1000; // 30 minutes

function pruneOldTasks(): void {
  const now = Date.now();
  for (const [id, task] of tasks) {
    if (now - task.startedAt > TASK_TTL_MS) {
      tasks.delete(id);
    }
  }
  // If still over limit, remove oldest completed
  if (tasks.size > MAX_TASKS) {
    const sorted = [...tasks.entries()]
      .filter(([, t]) => t.status !== "running")
      .sort((a, b) => a[1].startedAt - b[1].startedAt);
    while (tasks.size > MAX_TASKS && sorted.length > 0) {
      const [id] = sorted.shift()!;
      tasks.delete(id);
    }
  }
}

// ============================================
// SEARCH EXECUTORS
// ============================================

const DOTBOT_DIR = resolve(os.homedir(), ".bot");

async function executeFileContentSearch(query: string): Promise<{ results: string; count: number }> {
  // Use ripgrep (rg) if available, fall back to findstr on Windows
  const rgArgs = [
    "--no-heading",
    "--line-number",
    "--color", "never",
    "--max-count", "3",
    "--max-filesize", "1M",
    "-i",
    query,
  ];

  // Search common user directories
  const searchDirs = [
    resolve(os.homedir(), "Documents"),
    resolve(os.homedir(), "Desktop"),
    resolve(os.homedir(), "Downloads"),
  ];

  const allResults: string[] = [];

  for (const dir of searchDirs) {
    try {
      await fs.access(dir);
      const { stdout } = await execFileAsync("rg", [...rgArgs, dir], {
        timeout: 30000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      });
      if (stdout.trim()) {
        allResults.push(stdout.trim());
      }
    } catch (err: any) {
      // rg exit code 1 = no matches (normal), ENOENT = rg not installed
      if (err.code !== 1 && err.code !== "ENOENT") {
        console.warn(`[BackgroundSearch] rg failed for ${dir}:`, err.message || err.code);
      }
    }
  }

  if (allResults.length === 0) {
    return { results: `No file content matches found for "${query}".`, count: 0 };
  }

  const combined = allResults.join("\n");
  const lineCount = combined.split("\n").length;
  // Truncate if too large
  const maxChars = 8000;
  const truncated = combined.length > maxChars
    ? combined.substring(0, maxChars) + `\n\n... (truncated, ${lineCount} total matches)`
    : combined;

  return { results: truncated, count: lineCount };
}

async function executeDeepMemorySearch(query: string): Promise<{ results: string; count: number }> {
  // Import memory functions dynamically to avoid circular deps
  const { searchAndPromote } = await import("../memory/store.js");

  // searchAndPromote returns string[] of promoted slugs
  const promotedSlugs = await searchAndPromote(query);

  if (promotedSlugs.length === 0) {
    return { results: `No deep memory matches found for "${query}".`, count: 0 };
  }

  const lines = promotedSlugs.map((slug: string) =>
    `- **${slug}** [promoted from deep → hot memory]`
  );

  return {
    results: `Promoted ${promotedSlugs.length} model(s) from deep memory for "${query}":\n\n${lines.join("\n")}\n\nUse memory.get_model to read full details.`,
    count: promotedSlugs.length,
  };
}

async function executeArchivedThreadSearch(query: string): Promise<{ results: string; count: number }> {
  const archiveDir = join(DOTBOT_DIR, "memory", "threads", "archive");
  const queryLower = query.toLowerCase();
  const matches: string[] = [];

  try {
    const files = await fs.readdir(archiveDir);
    const jsonFiles = files.filter(f => f.endsWith(".json")).slice(0, 200);

    for (const file of jsonFiles) {
      try {
        const raw = await fs.readFile(join(archiveDir, file), "utf-8");
        const thread = JSON.parse(raw);
        const topic = thread.topic || "";
        const entities = (thread.entities || []).join(", ");
        const keywords = (thread.keywords || []).join(", ");
        const searchable = `${topic} ${entities} ${keywords}`.toLowerCase();

        if (searchable.includes(queryLower)) {
          const status = thread.status || "archived";
          const lastActive = thread.lastActiveAt || thread.archivedAt || "";
          matches.push(`- **${topic}** (${status}, ${lastActive}) [${file}]\n  Entities: ${entities || "none"} | Keywords: ${keywords || "none"}`);
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    return { results: `Archive directory not found or empty.`, count: 0 };
  }

  if (matches.length === 0) {
    return { results: `No archived threads found matching "${query}".`, count: 0 };
  }

  return {
    results: `Found ${matches.length} archived thread(s) matching "${query}":\n\n${matches.join("\n\n")}`,
    count: matches.length,
  };
}

// ============================================
// PUBLIC API
// ============================================

export function startBackgroundSearch(
  type: BackgroundSearchTask["type"],
  query: string
): string {
  pruneOldTasks();

  const id = `bgs_${nanoid(8)}`;
  const task: BackgroundSearchTask = {
    id,
    type,
    query,
    status: "running",
    startedAt: Date.now(),
  };
  tasks.set(id, task);

  // Run async — don't await
  const executor = type === "file_content" ? executeFileContentSearch
    : type === "deep_memory" ? executeDeepMemorySearch
    : executeArchivedThreadSearch;

  executor(query)
    .then(({ results, count }) => {
      task.status = "done";
      task.completedAt = Date.now();
      task.results = results;
      task.resultCount = count;
    })
    .catch((err) => {
      task.status = "error";
      task.completedAt = Date.now();
      task.error = err instanceof Error ? err.message : String(err);
    });

  return id;
}

export function checkSearchResults(taskId: string): BackgroundSearchTask | null {
  return tasks.get(taskId) || null;
}

/** For testing */
export function _clearTasks(): void {
  tasks.clear();
}
