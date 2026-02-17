/**
 * Tool, Task, Skill, Persona & Council Types
 *
 * Split from types.ts for maintainability. Contains types for:
 * - Task tracking
 * - Skills system (MCP Tool compatible)
 * - Tool plugin architecture
 * - Persona and council local storage
 */

// ============================================
// TASK TRACKING
// ============================================

/**
 * Task status lifecycle:
 *   pending → in_progress → completed
 *                         → failed
 *                         → blocked (needs human input, disconnect, bad tool call, etc.)
 *
 * Blocked/failed tasks can be retried:
 *   blocked → in_progress (pulse picks it up)
 *   failed  → in_progress (on retry)
 */
export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "blocked";

/**
 * A sub-step within a compound task
 */
export interface TaskStep {
  id: string;
  description: string;
  status: TaskStatus;
  personaId?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

/**
 * A tracked task — persisted to ~/.bot/tasks.json
 */
export interface Task {
  id: string;
  /** What needs to be done (from receptionist formattedRequest or user prompt) */
  description: string;
  status: TaskStatus;
  priority: "low" | "medium" | "high";
  createdAt: string;
  updatedAt: string;
  completedAt?: string;

  /** Linked conversation thread */
  threadId?: string;
  /** Who was/should work on it */
  personaId?: string;
  /** The user's original prompt text */
  originPrompt: string;

  /** Sub-steps for compound tasks */
  steps: TaskStep[];

  /** Why this task is blocked */
  blockedReason?: string;
  /** Last error message */
  lastError?: string;
  /** How many times we've retried */
  retryCount: number;

  /** Last assistant response (for context on resumption) */
  lastResponse?: string;
}

/**
 * The task log file structure
 */
export interface TaskLog {
  version: string;
  lastUpdatedAt: string;
  tasks: Task[];
}

// ============================================
// SKILLS SYSTEM (SKILL.md Standard)
// ============================================

/**
 * JSON Schema type (MCP standard uses JSON Schema 2020-12)
 * This is a simplified representation - actual schemas follow JSON Schema spec
 */
export interface JSONSchema {
  $schema?: string;
  type?: string | string[];
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  description?: string;
  default?: any;
  enum?: any[];
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  additionalProperties?: boolean | JSONSchema;
  [key: string]: any;
}

/**
 * MCP Tool Annotations (standard)
 * Describes tool behavior for trust & safety
 */
export interface MCPToolAnnotations {
  /** If true, tool doesn't modify external state */
  readOnlyHint?: boolean;
  /** If true, tool mutates external state. Preferred over heuristic classification. */
  mutatingHint?: boolean;
  /** If true, tool is suitable for verification/read-back checks after a mutating action. */
  verificationHint?: boolean;
  /** If true, tool may have destructive effects */
  destructiveHint?: boolean;
  /** If true, tool may take significant time */
  longRunningHint?: boolean;
  /** If true, tool may incur costs */
  costHint?: boolean;
  /** If true, tool requires user confirmation */
  requiresConfirmation?: boolean;
}

/**
 * MCP Tool Definition (standard - from MCP spec)
 * @see https://modelcontextprotocol.io/specification
 */
export interface MCPTool {
  /** Unique identifier (1-128 chars, alphanumeric + _-.) */
  name: string;
  /** Optional human-readable title for display */
  title?: string;
  /** Human-readable description of functionality */
  description: string;
  /** JSON Schema defining expected input parameters */
  inputSchema: JSONSchema;
  /** Optional JSON Schema defining expected output structure */
  outputSchema?: JSONSchema;
  /** Optional metadata about tool behavior */
  annotations?: MCPToolAnnotations;
}

/**
 * SKILL.md frontmatter — parsed from YAML between --- markers
 */
export interface SkillFrontmatter {
  /** Skill name, becomes the /slash-command */
  name: string;
  /** What this skill does — helps the system decide when to auto-load */
  description: string;
  /** If true, only the user can invoke via /command (not auto-triggered) */
  "disable-model-invocation"?: boolean;
  /** If false, skill is not available as a /command (background knowledge only) */
  "user-invocable"?: boolean;
  /** Restrict which tools the skill can use */
  "allowed-tools"?: string[];
  /** Tags for search/discovery (DotBot extension) */
  tags?: string[];
}

/**
 * DotBot Skill — directory-based, follows Claude Code SKILL.md standard
 * 
 * Each skill lives at ~/.bot/skills/{slug}/SKILL.md
 * Optional supporting files: scripts/, examples/, reference.md
 */
export interface Skill {
  /** Directory name (URL-friendly) */
  slug: string;
  /** From frontmatter: name */
  name: string;
  /** From frontmatter: description */
  description: string;
  /** The markdown body (instructions the LLM follows) */
  content: string;
  /** From frontmatter: tags */
  tags: string[];
  /** From frontmatter: disable-model-invocation */
  disableModelInvocation: boolean;
  /** From frontmatter: user-invocable */
  userInvocable: boolean;
  /** From frontmatter: allowed-tools */
  allowedTools: string[];
  /** Supporting files in the skill directory (relative paths) */
  supportingFiles: string[];
  /** File timestamps */
  createdAt: string;
  lastUpdatedAt: string;
}

/**
 * Compact skill listing entry
 */
export interface SkillIndexEntry {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  allowedTools: string[];
  disableModelInvocation: boolean;
  userInvocable: boolean;
}

// ============================================
// TOOL SYSTEM (Plugin Architecture)
// ============================================

/**
 * Supported client platforms for tool filtering.
 * Used to determine which tools are available on each platform.
 */
export type Platform = "windows" | "linux" | "macos" | "web";

/**
 * DotBot Tool — extends MCP Tool with execution and source metadata.
 *
 * Tools are atomic capabilities the agent can invoke. They come from:
 * - core: ship with the local agent (filesystem, shell, http, etc.)
 * - api: auto-generated from API specs (weather, search, etc.)
 * - mcp: discovered from MCP servers (Notion, Linear, etc.)
 * - skill: learned skills exposed as callable tools
 * - custom: user-written tool definitions in ~/.bot/tools/custom/
 */
export interface DotBotTool extends MCPTool {
  /** Dotted identifier like "filesystem.create_file" */
  id: string;
  /** Where this tool came from */
  source: "core" | "mcp" | "api" | "skill" | "custom";
  /** Logical category for grouping */
  category: string;
  /** Where the tool executes */
  executor: "local" | "server-proxy";
  /** Execution runtime */
  runtime?: "powershell" | "node" | "python" | "http" | "mcp" | "internal";

  /**
   * Which platforms this tool works on.
   * Used for filtering when building the manifest for a specific client.
   * Defaults to ["windows", "linux", "macos"] if not specified.
   */
  platforms?: Platform[];

  /**
   * Credential vault reference name. If set, the credential must exist
   * in the server-encrypted vault. API calls are proxied through the server
   * which decrypts and injects the credential. The LLM only sees the
   * reference name and whether it's configured — never the value.
   */
  credentialRequired?: string;

  /** API-specific config (source: "api") */
  apiSpec?: {
    baseUrl: string;
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
    path: string;
    headers?: Record<string, string>;
    queryParams?: Record<string, string>;
    authType: "bearer" | "api-key-header" | "api-key-query" | "basic" | "none";
    keySource: "local-env" | "server-managed";
    keyEnvVar?: string;
  };

  /** MCP-specific config (source: "mcp") */
  mcpServer?: string;

  /**
   * Research cache configuration. If set, successful tool results are
   * automatically cached to ~/.bot/memory/research-cache/ for follow-up use.
   *
   * - "raw": save output as-is (search results, instant answers — already structured)
   * - "enrich": save + generate brief/headnote + tags + related memory models
   *            (web pages, PDFs, transcripts — long/unstructured content)
   */
  cache?: {
    mode: "raw" | "enrich";
    type: "web_page" | "web_search" | "api_response" | "pdf_summary" | "video_transcript" | "image_description";
  };
}

/**
 * Lightweight manifest entry sent to the server for prompt generation.
 * Does NOT include execution details — the server only needs enough
 * to generate tool prompts and route calls back.
 */
export interface ToolManifestEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  inputSchema: JSONSchema;
  annotations?: MCPToolAnnotations;
  /** Which platforms this tool works on. */
  platforms?: Platform[];
  /** Credential vault reference name (e.g., "DISCORD_BOT_TOKEN"). Never contains the actual value. */
  credentialRequired?: string;
  /** Whether the required credential is configured in the local vault. Safe to share — boolean only. */
  credentialConfigured?: boolean;
}

/**
 * Full tool registry stored on the local agent.
 */
export interface ToolRegistry {
  version: string;
  lastUpdatedAt: string;
  tools: DotBotTool[];
}

// ============================================
// PERSONAS (Local Storage)
// ============================================

/**
 * A persona's core identity and behavior definition
 */
export interface Persona {
  slug: string;
  name: string;
  /** One-line description of this persona's role */
  role: string;
  /** Detailed description of capabilities and approach */
  description: string;
  /** The system prompt that defines this persona's behavior */
  systemPrompt: string;
  /** Model tier preference: fast for quick tasks, smart for analysis, powerful for complex reasoning */
  modelTier: "fast" | "smart" | "powerful";
  /** Tools this persona can use */
  tools: string[];
  /** Personality traits that influence response style */
  traits: string[];
  /** Areas of expertise */
  expertise: string[];
  /** When to involve this persona (trigger conditions) */
  triggers: string[];
  /** Knowledge files available to this persona (relative paths in knowledge/) */
  knowledgeFiles: string[];
  /** When set, forces this persona to always use the specified model role.
   *  Overrides all task-based detection in selectModel(). */
  modelRole?: "workhorse" | "deep_context" | "architect" | "local";
  /** When true, this persona is only used by councils — hidden from receptionist routing. */
  councilOnly?: boolean;
  createdAt: string;
  lastUpdatedAt: string;
}

/**
 * A knowledge document for a persona
 */
export interface KnowledgeDocument {
  filename: string;
  title: string;
  description: string;
  content: string;
  tags: string[];
  lastUpdatedAt: string;
}

/**
 * Persona index entry
 */
export interface PersonaIndexEntry {
  slug: string;
  name: string;
  role: string;
  modelTier: string;
  knowledgeFileCount: number;
}

/**
 * Personas index file
 */
export interface PersonasIndex {
  version: string;
  lastUpdatedAt: string;
  personas: PersonaIndexEntry[];
}

// ============================================
// COUNCILS (Local Storage)
// ============================================

/**
 * A council member reference with role in the council
 */
export interface CouncilMember {
  personaSlug: string;
  /** Role within this specific council (e.g., "reviewer", "approver", "advisor") */
  councilRole: string;
  /** Order in the execution sequence (lower = earlier) */
  sequence: number;
  /** When this member should be consulted */
  invocationConditions?: string[];
  /** Must this member approve for the council to pass? Default true. */
  required: boolean;
  /** Override the persona's default LLM provider for this council seat */
  providerOverride?: "deepseek" | "anthropic" | "openai" | "gemini" | "local";
  /** Override the persona's default model for this council seat */
  modelOverride?: string;
  /** Additional review instructions specific to this council seat */
  reviewFocus?: string;
}

/**
 * A governing principle for the council
 */
export interface GoverningPrinciple {
  id: string;
  title: string;
  description: string;
  /** Priority when principles conflict (higher = more important) */
  priority: number;
}

/**
 * A council definition - a group of personas working toward a shared mission
 * 
 * Councils are the "polishing" layer. Internal personas do the work;
 * councils review, refine, and approve the output.
 */
export interface Council {
  slug: string;
  name: string;
  /** The council's stated mission */
  mission: string;
  /** Detailed description of the council's purpose and scope */
  description: string;
  /** Governing principles that guide decision-making */
  principles: GoverningPrinciple[];
  /** Personas that make up this council */
  members: CouncilMember[];
  /** Types of requests this council handles */
  handles: string[];
  /** Default execution path through members */
  defaultPath: string[];
  /** Tags for categorization */
  tags: string[];
  
  // --- Execution Mode ---
  
  /** 
   * single_pass: Each member reviews once in sequence (round-robin).
   * iterative: Members review in a loop until all required members approve
   *            or maxIterations is reached.
   */
  executionMode: "single_pass" | "iterative";
  /** Maximum review rounds for iterative mode (safety limit). Default 3. */
  maxIterations?: number;
  
  createdAt: string;
  lastUpdatedAt: string;
}

/**
 * Council index entry
 */
export interface CouncilIndexEntry {
  slug: string;
  name: string;
  mission: string;
  memberCount: number;
  handles: string[];
}

/**
 * Councils index file
 */
export interface CouncilsIndex {
  version: string;
  lastUpdatedAt: string;
  councils: CouncilIndexEntry[];
}
