/**
 * Self-Learning Reflector — V2 Post-Task Analysis
 *
 * Runs AFTER a task completes (in the background, non-blocking).
 * Analyzes the agent's execution to identify:
 *
 * 1. Patterns worth remembering (e.g., "user prefers concise responses")
 * 2. Tool/skill creation opportunities (e.g., "this multi-step workflow
 *    could be saved as a skill")
 * 3. Execution efficiency issues (e.g., "used 30 iterations when 5 would
 *    have sufficed — prompt was too vague")
 *
 * The reflector does NOT modify the system in real-time. It produces
 * recommendations that are persisted via the memory system and optionally
 * surfaced to the user.
 *
 * This is the foundation of DotBot's self-improvement loop:
 * - Reflector identifies patterns → creates skills/tools autonomously
 * - LLM decides on creation (user deletes if unwanted)
 */

import { createComponentLogger } from "../logging.js";
import { resolveModelAndClient } from "./execution.js";
import type { ILLMClient } from "../llm/providers.js";
import type { AgentRunnerOptions } from "./runner-types.js";

const log = createComponentLogger("reflector");

// ============================================
// SKILL CREATION RATE LIMITER
// ============================================

/** Max skills the reflector can create per calendar day. */
const MAX_SKILLS_PER_DAY = 5;

/** Tracks skill creation per day to prevent spam. */
const skillCreationLog: { date: string; slugs: string[] } = {
  date: new Date().toISOString().slice(0, 10),
  slugs: [],
};

function canCreateSkill(slug: string): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (skillCreationLog.date !== today) {
    // New day — reset
    skillCreationLog.date = today;
    skillCreationLog.slugs = [];
  }
  // Check daily cap
  if (skillCreationLog.slugs.length >= MAX_SKILLS_PER_DAY) {
    log.warn("Reflector daily skill cap reached", { cap: MAX_SKILLS_PER_DAY, today });
    return false;
  }
  // Check dedup — don't recreate the same skill slug in one day
  if (skillCreationLog.slugs.includes(slug)) {
    log.info("Reflector skill already created today, skipping", { slug });
    return false;
  }
  return true;
}

function recordSkillCreation(slug: string): void {
  const today = new Date().toISOString().slice(0, 10);
  if (skillCreationLog.date !== today) {
    skillCreationLog.date = today;
    skillCreationLog.slugs = [];
  }
  skillCreationLog.slugs.push(slug);
}

// ============================================
// TYPES
// ============================================

export interface ReflectorInput {
  /** The original user message */
  originalPrompt: string;
  /** The final response sent to the user */
  finalResponse: string;
  /** Agent topic/persona label */
  agentId: string;
  /** Tool call summary (from work log) */
  toolCallSummary: string;
  /** How many iterations the tool loop used */
  iterations: number;
  /** Total execution time in ms */
  executionTimeMs: number;
  /** Whether the judge had to clean or rerun */
  judgeVerdict?: string;
  /** Whether research was delegated */
  researchUsed?: boolean;
}

export interface ReflectorOutput {
  /** Patterns observed about the user or task */
  patterns: string[];
  /** Suggested skills to create (multi-step workflows the agent did manually) */
  skillSuggestions: Array<{
    name: string;
    description: string;
    steps: string[];
    triggerPhrase: string;
  }>;
  /** Suggested tool improvements */
  toolSuggestions: Array<{
    toolId: string;
    issue: string;
    suggestion: string;
  }>;
  /** Suggested NEW tools to create (with code generation) */
  toolCreationSuggestions?: Array<{
    name: string;
    description: string;
    language: "python" | "javascript";
    purpose: string;
    inputs: string;
    expectedOutput: string;
  }>;
  /** Execution efficiency notes */
  efficiencyNotes: string[];
  /** Whether the reflector thinks this task type will recur */
  likelyRecurring: boolean;
}

// ============================================
// REFLECTOR
// ============================================

/**
 * Run post-task reflection in the background.
 * Returns recommendations for the memory system.
 *
 * This runs async — the user's response is already sent.
 * Failures are silently logged, never surfaced to the user.
 */
export async function runReflector(
  llm: ILLMClient,
  options: AgentRunnerOptions,
  input: ReflectorInput
): Promise<ReflectorOutput | null> {
  try {
    const { selectedModel: modelConfig, client } = await resolveModelAndClient(
      llm,
      { explicitRole: "intake" }  // Use fast model — this is background work
    );

    const systemPrompt = `You are a task execution analyst. After an agent completes a task, you analyze the execution to find patterns and improvement opportunities.

You produce a JSON report with:
1. **patterns**: Observations about the user's preferences or recurring needs (e.g., "User prefers Markdown tables for comparisons")
2. **skillSuggestions**: Multi-step workflows that could be saved as reusable skills. Only suggest when you see 3+ tool calls that form a coherent workflow (e.g., "search → compare → format as table" = potential "competitor analysis" skill)
3. **toolSuggestions**: Issues with specific tools (e.g., "search.brave_search returned irrelevant results for technical queries — might need a docs-specific search")
4. **toolCreationSuggestions**: NEW tools that should be created as Python/JS code. Only suggest when:
   - The agent needed a capability that doesn't exist in current tools
   - The operation is deterministic and testable (data transformation, parsing, calculation, API wrapper)
   - It would save significant manual work in future tasks
   For each suggestion, specify: name, description, language (python or javascript), purpose, inputs (what parameters it takes), expectedOutput (what it should return)
5. **efficiencyNotes**: Execution inefficiencies (too many iterations, redundant searches, unnecessary tool calls)
6. **likelyRecurring**: Whether this type of task will likely be requested again

## Rules
- Be concise — each entry should be one sentence
- Only suggest skills for workflows with 3+ distinct steps
- Only suggest tool creation for operations that are deterministic and testable (NOT for complex AI tasks or web scraping)
- Don't suggest skills/tools for one-off tasks
- Focus on actionable insights, not obvious observations

Respond with JSON.`;

    const userMessage = `## Task Execution Summary

**User Request:** ${input.originalPrompt}
**Agent:** ${input.agentId}
**Iterations:** ${input.iterations}
**Execution Time:** ${Math.round(input.executionTimeMs / 1000)}s
**Judge Verdict:** ${input.judgeVerdict || "pass"}
**Research Delegated:** ${input.researchUsed ? "yes" : "no"}

**Tool Calls:**
${input.toolCallSummary || "(no tool calls)"}

**Final Response (first 500 chars):**
${input.finalResponse.substring(0, 500)}${input.finalResponse.length > 500 ? "..." : ""}

Analyze this execution.`;

    const messages: { role: "system" | "user"; content: string }[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    const reflStartTime = Date.now();
    const response = await client.chat(messages, {
      model: modelConfig.model,
      maxTokens: 1000,
      temperature: 0.3,
      responseFormat: "json_object",
    });

    options.onLLMResponse?.({
      persona: "reflector",
      duration: Date.now() - reflStartTime,
      responseLength: response.content.length,
      response: response.content,
      model: response.model,
      provider: response.provider,
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
    });

    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const output: ReflectorOutput = {
        patterns: parsed.patterns || [],
        skillSuggestions: parsed.skillSuggestions || parsed.skill_suggestions || [],
        toolSuggestions: parsed.toolSuggestions || parsed.tool_suggestions || [],
        toolCreationSuggestions: parsed.toolCreationSuggestions || parsed.tool_creation_suggestions || [],
        efficiencyNotes: parsed.efficiencyNotes || parsed.efficiency_notes || [],
        likelyRecurring: parsed.likelyRecurring ?? parsed.likely_recurring ?? false,
      };

      log.info("Reflector analysis complete", {
        patterns: output.patterns.length,
        skillSuggestions: output.skillSuggestions.length,
        toolSuggestions: output.toolSuggestions.length,
        likelyRecurring: output.likelyRecurring,
      });

      return output;
    }

    log.warn("Reflector returned non-JSON");
    return null;
  } catch (error) {
    log.error("Reflector failed (non-fatal)", { error });
    return null;
  }
}

// ============================================
// TOOL CODE GENERATION
// ============================================

interface GeneratedTool {
  name: string;
  language: "python" | "javascript";
  code: string;
  testCode: string;
  manifest: {
    id: string;
    name: string;
    description: string;
    inputSchema: any;
    outputSchema: any;
  };
}

/**
 * Generate actual tool code (Python or JS) using advanced LLM.
 * Creates both the tool implementation and test code.
 */
async function generateToolCode(
  llm: ILLMClient,
  options: AgentRunnerOptions,
  suggestion: {
    name: string;
    description: string;
    language: "python" | "javascript";
    purpose: string;
    inputs: string;
    expectedOutput: string;
  }
): Promise<GeneratedTool | null> {
  try {
    // Use architect-tier model for code generation (Opus/high-quality)
    const { selectedModel: modelConfig, client } = await resolveModelAndClient(
      llm,
      { explicitRole: "architect" }
    );

    const systemPrompt = `You are an expert tool developer. Generate production-quality, deterministic ${suggestion.language} code for a new tool.

## Requirements
- Code must be simple, focused, and follow best practices
- No external API calls (unless it's an API wrapper tool)
- Include proper error handling
- Include docstrings/comments
- Return JSON-serializable output
- Follow the coding patterns: simple, no premature abstractions

## Output Format
Respond with JSON containing:
{
  "code": "...the actual ${suggestion.language} code...",
  "testCode": "...test code that validates the tool works...",
  "inputSchema": {...JSON schema for tool inputs...},
  "outputSchema": {...JSON schema for tool output...}
}`;

    const userMessage = `Create a ${suggestion.language} tool:

**Name:** ${suggestion.name}
**Description:** ${suggestion.description}
**Purpose:** ${suggestion.purpose}
**Inputs:** ${suggestion.inputs}
**Expected Output:** ${suggestion.expectedOutput}

Generate the code and tests.`;

    const messages: { role: "system" | "user"; content: string }[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    const response = await client.chat(messages, {
      model: modelConfig.model,
      maxTokens: 4000,
      temperature: 0.2,
      responseFormat: "json_object",
    });

    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn("Tool generation returned non-JSON");
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.code || !parsed.testCode || !parsed.inputSchema) {
      log.warn("Tool generation incomplete", { hasCode: !!parsed.code, hasTests: !!parsed.testCode });
      return null;
    }

    const toolId = suggestion.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    return {
      name: suggestion.name,
      language: suggestion.language,
      code: parsed.code,
      testCode: parsed.testCode,
      manifest: {
        id: `local.${toolId}`,
        name: suggestion.name,
        description: suggestion.description,
        inputSchema: parsed.inputSchema,
        outputSchema: parsed.outputSchema || { type: "object" },
      },
    };
  } catch (error) {
    log.error("Tool code generation failed", { error, tool: suggestion.name });
    return null;
  }
}

/**
 * Run tool tests to validate the generated code.
 * Returns true if all tests pass, false otherwise.
 */
async function runToolTests(
  tool: GeneratedTool,
  options: AgentRunnerOptions
): Promise<boolean> {
  try {
    if (!options.onExecuteCommand) {
      log.warn("Tool tests skipped: onExecuteCommand not available");
      return false;
    }

    log.info("Running tool tests", { tool: tool.name, language: tool.language });

    // Write tool code and test code to temp files
    const { writeFileSync, mkdirSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const { randomBytes } = await import("crypto");

    const testDir = join(tmpdir(), `dotbot_tool_test_${randomBytes(8).toString("hex")}`);
    mkdirSync(testDir, { recursive: true });

    const ext = tool.language === "python" ? "py" : "js";
    const toolFile = join(testDir, `tool.${ext}`);
    const testFile = join(testDir, `test.${ext}`);

    writeFileSync(toolFile, tool.code, "utf-8");
    writeFileSync(testFile, tool.testCode, "utf-8");

    // Execute tests via onExecuteCommand
    const command = tool.language === "python"
      ? `cd "${testDir}" && python test.py`
      : `cd "${testDir}" && node test.js`;

    const result = await options.onExecuteCommand({
      id: `tool_test_${tool.manifest.id}`,
      type: "tool_execute",
      payload: {
        toolId: "system.shell",
        toolArgs: { command },
      },
      dryRun: false,
      timeout: 30000,
      sandboxed: true,
      requiresApproval: false,
    });

    // Clean up temp files
    const { rmSync } = await import("fs");
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }

    // Check if tests passed (exit code 0 and no error in output)
    if (result && typeof result === "object") {
      const exitCode = (result as any).exitCode;
      const output = (result as any).output || (result as any).stdout || "";
      const testPassed = exitCode === 0 && !output.toLowerCase().includes("failed") && !output.toLowerCase().includes("error");

      log.info("Tool tests completed", { tool: tool.name, passed: testPassed, exitCode });
      return testPassed;
    }

    log.warn("Tool tests: unexpected result format", { tool: tool.name });
    return false;
  } catch (error) {
    log.error("Tool tests failed", { error, tool: tool.name });
    return false;
  }
}

/**
 * Deploy a validated tool to the local tools directory.
 */
async function deployTool(
  tool: GeneratedTool,
  options: AgentRunnerOptions
): Promise<boolean> {
  try {
    if (!options.onExecuteCommand) {
      log.warn("Tool deployment skipped: onExecuteCommand not available");
      return false;
    }

    log.info("Deploying tool", { tool: tool.name, id: tool.manifest.id });

    // Write tool to local-agent/tools/ directory
    // Use onExecuteCommand to write files safely
    const result = await options.onExecuteCommand({
      id: `deploy_tool_${tool.manifest.id}`,
      type: "tool_execute",
      payload: {
        toolId: "system.write_file",
        toolArgs: {
          path: `local-agent/tools/${tool.manifest.id}.${tool.language === "python" ? "py" : "js"}`,
          content: tool.code,
        },
      },
      dryRun: false,
      timeout: 5000,
      sandboxed: false,
      requiresApproval: false,
    });

    if (!result) {
      log.warn("Tool deployment failed: no result", { tool: tool.name });
      return false;
    }

    // Write manifest
    await options.onExecuteCommand({
      id: `deploy_manifest_${tool.manifest.id}`,
      type: "tool_execute",
      payload: {
        toolId: "system.write_file",
        toolArgs: {
          path: `local-agent/tools/${tool.manifest.id}.json`,
          content: JSON.stringify(tool.manifest, null, 2),
        },
      },
      dryRun: false,
      timeout: 5000,
      sandboxed: false,
      requiresApproval: false,
    });

    log.info("Tool deployed successfully", { tool: tool.name, id: tool.manifest.id });
    return true;
  } catch (error) {
    log.error("Tool deployment failed", { error, tool: tool.name });
    return false;
  }
}

/**
 * Run the reflector in the background (fire-and-forget).
 * Results are persisted via onPersistMemory if available.
 * Skills and tools are created autonomously via onExecuteCommand.
 */
export function runReflectorAsync(
  llm: ILLMClient,
  options: AgentRunnerOptions,
  input: ReflectorInput
): void {
  setImmediate(async () => {
    const output = await runReflector(llm, options, input);
    if (!output) return;

    // Persist patterns as memory observations
    if (output.patterns.length > 0 && options.onPersistMemory) {
      try {
        await options.onPersistMemory("add_observations", {
          observations: output.patterns,
          source: "reflector",
          agentId: input.agentId,
        });
      } catch (err) {
        log.warn("Failed to persist reflector patterns", { error: err });
      }
    }

    // Create skills autonomously via onExecuteCommand → skills.save_skill
    // The LLM decides, user deletes if unwanted (per architecture doc)
    if (output.skillSuggestions.length > 0 && options.onExecuteCommand) {
      for (const skill of output.skillSuggestions) {
        try {
          const slug = skill.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

          // Rate limit: daily cap + dedup
          if (!canCreateSkill(slug)) continue;

          // Quality gate: validate skill has minimum viable content
          if (!skill.name || skill.name.length < 3) {
            log.warn("Reflector skill rejected: name too short", { name: skill.name });
            continue;
          }
          if (!skill.description || skill.description.length < 10) {
            log.warn("Reflector skill rejected: description too short", { name: skill.name });
            continue;
          }
          if (!skill.steps || skill.steps.length < 3) {
            log.warn("Reflector skill rejected: too few steps (minimum 3)", { name: skill.name, steps: skill.steps?.length || 0 });
            continue;
          }
          // Reject if steps are too vague
          const vagueSteps = skill.steps.filter(s => s.length < 15 || /^(do|run|execute|perform|check)\s+\w+$/i.test(s));
          if (vagueSteps.length > skill.steps.length / 2) {
            log.warn("Reflector skill rejected: steps too vague", { name: skill.name, vagueSteps: vagueSteps.length });
            continue;
          }

          const content = [
            `# ${skill.name}`,
            "",
            skill.description,
            "",
            "## Steps",
            ...skill.steps.map((s, i) => `${i + 1}. ${s}`),
          ].join("\n");

          log.info("Reflector creating skill", { name: skill.name, slug, steps: skill.steps.length });

          await options.onExecuteCommand({
            id: `reflector_skill_${slug}`,
            type: "tool_execute",
            payload: {
              toolId: "skills.save_skill",
              toolArgs: {
                name: slug,
                description: skill.description,
                content,
                tags: skill.triggerPhrase || skill.name,
              },
            },
            dryRun: false,
            timeout: 15000,
            sandboxed: false,
            requiresApproval: false,
          });

          recordSkillCreation(slug);
          log.info("Reflector skill created", { slug });

          // Notify user
          if (options.onTaskProgress) {
            options.onTaskProgress({
              taskId: `reflector_skill_${slug}`,
              status: "completed",
              message: `✨ New skill created: **${skill.name}** — ${skill.description}`,
            });
          }
        } catch (err) {
          log.warn("Failed to create reflector skill", { name: skill.name, error: err });
        }
      }
    }

    // Create NEW tools with code generation + test validation
    if (output.toolCreationSuggestions && output.toolCreationSuggestions.length > 0 && options.onExecuteCommand) {
      for (const suggestion of output.toolCreationSuggestions) {
        try {
          log.info("Reflector generating tool code", { name: suggestion.name, language: suggestion.language });

          // Generate tool code and tests
          const generatedTool = await generateToolCode(llm, options, suggestion);
          if (!generatedTool) {
            log.warn("Tool code generation failed", { name: suggestion.name });
            continue;
          }

          // Run tests to validate the tool works
          const testsPassed = await runToolTests(generatedTool, options);
          if (!testsPassed) {
            log.warn("Tool tests failed, skipping deployment", { name: suggestion.name });
            // Persist as a note for manual review
            if (options.onPersistMemory) {
              await options.onPersistMemory("add_observations", {
                observations: [`Tool generation attempted but tests failed: ${suggestion.name} — manual review needed`],
                source: "reflector",
                agentId: input.agentId,
              });
            }
            continue;
          }

          // Tests passed — deploy the tool
          const deployed = await deployTool(generatedTool, options);
          if (deployed) {
            log.info("Reflector created and deployed new tool", { name: suggestion.name, id: generatedTool.manifest.id });

            // Notify user directly
            if (options.onTaskProgress) {
              options.onTaskProgress({
                taskId: `reflector_tool_${generatedTool.manifest.id}`,
                status: "completed",
                message: `🛠️ New tool created: **${suggestion.name}** (${generatedTool.manifest.id}) — ${suggestion.description}. Tests passed ✓`,
              });
            }

            // Also persist to memory system
            if (options.onPersistMemory) {
              await options.onPersistMemory("add_observations", {
                observations: [`New tool created: ${suggestion.name} (${generatedTool.manifest.id}) — validated and deployed`],
                source: "reflector",
                agentId: input.agentId,
              });
            }
          }
        } catch (err) {
          log.error("Tool creation workflow failed", { name: suggestion.name, error: err });
        }
      }
    }

    // Create tools autonomously via onExecuteCommand → tools.save_tool
    // Only for tool suggestions that include enough info for a new API tool
    if (output.toolSuggestions.length > 0 && options.onExecuteCommand) {
      for (const suggestion of output.toolSuggestions) {
        try {
          // Guard: LLM may omit fields — skip malformed entries
          if (!suggestion.suggestion || typeof suggestion.suggestion !== "string") {
            log.warn("Reflector tool suggestion missing 'suggestion' field", { toolId: suggestion.toolId });
            continue;
          }
          // Only act on suggestions that have a concrete tool creation proposal
          // (not just "this tool had bad results" feedback)
          const text = suggestion.suggestion.toLowerCase();
          if (text.includes("create") || text.includes("wrap") || text.includes("new tool")) {
            log.info("Reflector tool suggestion noted for future action", {
              toolId: suggestion.toolId,
              suggestion: suggestion.suggestion,
            });
            // Tool creation is more complex (needs API spec or script code)
            // — persist as a memory note for the next relevant agent to act on
            if (options.onPersistMemory) {
              try {
                await options.onPersistMemory("add_observations", {
                  observations: [`Tool improvement needed: ${suggestion.toolId} — ${suggestion.suggestion}`],
                  source: "reflector",
                  agentId: input.agentId,
                });
              } catch { /* non-fatal */ }
            }
          }
        } catch (err) {
          log.warn("Failed to process reflector tool suggestion", { toolId: suggestion?.toolId, error: err });
        }
      }
    }

    // Persist efficiency notes as memory (helps future agents avoid the same mistakes)
    if (output.efficiencyNotes.length > 0 && options.onPersistMemory) {
      try {
        await options.onPersistMemory("add_observations", {
          observations: output.efficiencyNotes.map(n => `Efficiency: ${n}`),
          source: "reflector",
          agentId: input.agentId,
        });
      } catch { /* non-fatal */ }
    }
  });
}
