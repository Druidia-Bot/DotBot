/**
 * Tool Definitions
 * 
 * Converts the dynamic tool manifest from the local agent's plugin registry
 * into native ToolDefinition[] for LLM function calling. Also provides
 * system context generation and tool capabilities summaries for intake agents.
 */

import { hostname, platform, release, arch } from "os";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { ToolDefinition } from "../llm/types.js";

// ============================================
// TEMPLATE LOADER
// ============================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = resolve(__dirname, "..", "prompts");

const templateCache = new Map<string, string>();

/**
 * Load a .md prompt template and replace {{PLACEHOLDER}} tokens with values.
 * Templates are cached after first read.
 */
function loadTemplate(filename: string, replacements: Record<string, string> = {}): string {
  let template = templateCache.get(filename);
  if (!template) {
    template = readFileSync(resolve(PROMPTS_DIR, filename), "utf-8");
    templateCache.set(filename, template);
  }
  let result = template;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  // Strip any remaining unreplaced placeholders
  result = result.replace(/\{\{[A-Z_]+\}\}/g, "");
  return result;
}

/** Clear the template cache (useful if templates are edited at runtime). */
export function clearTemplateCache(): void {
  templateCache.clear();
}

// ============================================
// SYSTEM CONTEXT
// ============================================

/**
 * Generate a system context block with date/time, OS, and environment info.
 * Useful for any prompt where temporal or system awareness matters.
 */
export function getSystemContext(runtimeInfo?: any[]): string {
  const now = new Date();
  const tzOffset = -now.getTimezoneOffset();
  const tzHours = Math.floor(Math.abs(tzOffset) / 60);
  const tzMins = Math.abs(tzOffset) % 60;
  const tzSign = tzOffset >= 0 ? "+" : "-";
  const tz = `UTC${tzSign}${String(tzHours).padStart(2, "0")}:${String(tzMins).padStart(2, "0")}`;

  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeStr = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

  // Build runtimes summary
  let runtimesSummary = "";
  if (runtimeInfo && runtimeInfo.length > 0) {
    const lines = runtimeInfo.map((r: any) => {
      if (r.available) {
        return `- **${r.name}**: ${r.version || "available"}`;
      } else {
        return `- **${r.name}**: NOT installed${r.installHint ? ` (${r.installHint})` : ""}`;
      }
    });
    runtimesSummary = lines.join("\n");
  }

  return loadTemplate("system-context.md", {
    DATE: dateStr,
    TIME: timeStr,
    TIMEZONE: tz,
    OS: platform() === "win32" ? "Windows" : platform(),
    OS_RELEASE: release(),
    OS_ARCH: arch(),
    HOSTNAME: hostname(),
    USERNAME: process.env.USERNAME || process.env.USER || "unknown",
    USER_PROFILE: process.env.USERPROFILE || process.env.HOME || "",
    RUNTIMES: runtimesSummary,
  });
}

// ============================================
// PROMPT GENERATION
// ============================================

// ============================================
// TOOL MANIFEST TYPES (from local agent)
// ============================================

/** Supported client platforms for tool filtering. */
export type Platform = "windows" | "linux" | "macos" | "web";

export interface ToolManifestEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  inputSchema: {
    type?: string;
    properties?: Record<string, any>;
    required?: string[];
  };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    requiresConfirmation?: boolean;
  };
  /** Which platforms this tool works on. */
  platforms?: Platform[];
  /** Credential vault reference name (e.g., "DISCORD_BOT_TOKEN"). Never contains the actual value. */
  credentialRequired?: string;
  /** Whether the required credential is configured in the local vault. Safe — boolean only. */
  credentialConfigured?: boolean;
}

/**
 * Generate the tool-use behavioral guidance block.
 * Tool definitions are now passed structurally via native function calling —
 * this only returns strategy/workflow guidance for how to use them.
 */
export function generateToolPrompt(): string {
  return loadTemplate("tool-prompt.md", {});
}

/**
 * Sanitize a tool ID for use as a native function name.
 * OpenAI/Anthropic restrict names to [a-zA-Z0-9_-], so dots become double underscores.
 */
export function sanitizeToolName(id: string): string {
  return id.replace(/\./g, "__");
}

/**
 * Reverse sanitizeToolName — convert double underscores back to dots.
 */
export function unsanitizeToolName(name: string): string {
  return name.replace(/__/g, ".");
}

/**
 * Convert a tool manifest into native ToolDefinition[] for the LLM's tools parameter.
 * Tool IDs are sanitized (dots → __) to comply with function name restrictions.
 * Returns an empty array if no manifest is provided.
 */
export function manifestToNativeTools(manifest?: ToolManifestEntry[]): ToolDefinition[] {
  if (!manifest || manifest.length === 0) return [];

  return manifest.map(t => ({
    type: "function" as const,
    function: {
      name: sanitizeToolName(t.id),
      description: t.description,
      parameters: {
        type: "object",
        properties: t.inputSchema?.properties || {},
        required: t.inputSchema?.required || [],
      },
    },
  }));
}

/**
 * Generate a compact tool capabilities summary for intake agents (receptionist, planner).
 * Shows which tool categories exist, highlights learned/custom tools,
 * and maps persona tool access so routing decisions account for tool availability.
 */
export function generateToolCapabilitiesSummary(
  manifest?: ToolManifestEntry[],
  personaTools?: Record<string, string[]>
): string {
  if (!manifest || manifest.length === 0) return "";

  // Group by category
  const grouped = new Map<string, ToolManifestEntry[]>();
  for (const t of manifest) {
    const cat = t.category || "general";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(t);
  }

  // Separate core from learned/custom tools.
  // Premium tools get detailed descriptions (planner needs to know what they DO for staffing).
  const coreCategories: string[] = [];
  const learnedTools: ToolManifestEntry[] = [];
  const premiumTools: ToolManifestEntry[] = [];
  for (const [cat, tools] of grouped) {
    if (cat === "premium") {
      coreCategories.push(`${cat} (${tools.length})`);
      premiumTools.push(...tools);
    } else if (["filesystem", "directory", "shell", "http", "clipboard", "browser", "system", "network", "secrets", "search", "tools", "skills", "codegen", "npm", "git", "runtime", "gui", "discord", "market", "reminder", "onboarding"].includes(cat)) {
      coreCategories.push(`${cat} (${tools.length})`);
    } else {
      learnedTools.push(...tools);
    }
  }

  // Build learned tools section
  let learnedSection = "";
  if (learnedTools.length > 0) {
    learnedSection = "**Learned/API tools** (self-discovered, always available):\n";
    for (const t of learnedTools) {
      learnedSection += `- **${t.name}** (${t.category}): ${t.description}\n`;
    }
  }

  // Build persona tool access section
  let personaSection = "";
  if (personaTools && Object.keys(personaTools).length > 0) {
    personaSection = "**Persona tool access:**\n";
    for (const [pid, cats] of Object.entries(personaTools)) {
      if (cats.includes("none")) {
        personaSection += `- ${pid}: no tools (text-only)\n`;
      } else if (cats.includes("all")) {
        personaSection += `- ${pid}: all tools\n`;
      } else {
        personaSection += `- ${pid}: ${cats.join(", ")}\n`;
      }
    }
  }

  // Build premium tools section — planner needs to know what premium tools DO
  let premiumSection = "";
  if (premiumTools.length > 0) {
    premiumSection = "**Premium tools** (cost credits, only available to personas with `premium` access):\n";
    for (const t of premiumTools) {
      premiumSection += `- **${t.name}**: ${t.description}\n`;
    }
  }

  return loadTemplate("tool-capabilities.md", {
    CORE_CATEGORIES: coreCategories.join(", "),
    LEARNED_TOOLS_SECTION: learnedSection,
    PREMIUM_TOOLS_SECTION: premiumSection,
    PERSONA_TOOL_ACCESS: personaSection,
  });
}
