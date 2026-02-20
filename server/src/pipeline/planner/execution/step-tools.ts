/**
 * Step Tools — Per-Step Tool Set Builder
 *
 * Builds the tool definitions and handler map for a single step:
 *   - Filters the full manifest to the planner's toolIds for this step
 *   - Adds escape-hatch tools (tools.list_tools, tools.execute) always available
 *   - Adds the escalation synthetic tool
 *   - Wires up tools.execute passthrough handler
 */

import { createComponentLogger } from "#logging.js";
import { manifestToNativeTools, sanitizeToolName } from "#tools/manifest.js";
import { tools as toolDiscoveryDefs } from "#tools/definitions/server-tools.js";
import { buildStepExecutorHandlers } from "#tool-loop/index.js";
import {
  ESCALATE_TOOL_ID,
  escalateToolDefinition,
  escalateHandler,
} from "#tool-loop/handlers/synthetic-tools.js";
import type { ToolDefinition } from "#llm/types.js";
import type { ToolHandler } from "#tool-loop/types.js";
import type { ToolManifestEntry } from "#tools/types.js";
import type { Step } from "../types.js";

const log = createComponentLogger("step-tools");

/** Escape-hatch tools: always available to every step (tools.list_tools, tools.execute). */
const ESCAPE_HATCH_TOOLS: ToolDefinition[] = toolDiscoveryDefs.map(t => ({
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

export interface StepToolSet {
  tools: ToolDefinition[];
  handlers: Map<string, ToolHandler>;
}

export function buildStepToolSet(
  currentStep: Step,
  toolManifest: ToolManifestEntry[],
  workspacePath: string,
): StepToolSet {
  // Filter manifest to planner's toolIds for this step
  const stepToolIds = new Set(currentStep.toolIds);
  let stepManifest = toolManifest.filter(t => stepToolIds.has(t.id));
  if (stepManifest.length === 0) {
    log.warn("No tools matched step toolIds, using full manifest as fallback", {
      stepId: currentStep.id,
      requestedCount: currentStep.toolIds.length,
      manifestSize: toolManifest.length,
    });
    stepManifest = toolManifest;
  }

  // Handlers use the FULL manifest so tools.execute can reach any tool
  const handlers = buildStepExecutorHandlers(toolManifest, workspacePath);
  handlers.set(ESCALATE_TOOL_ID, escalateHandler());

  // tools.execute: passthrough handler that delegates to the full handler map
  handlers.set("tools.execute", async (handlerCtx, args) => {
    const toolId = args.tool_id;
    if (!toolId || typeof toolId !== "string") return "Error: tool_id is required";
    const handler = handlers.get(toolId);
    if (!handler) return `Error: Unknown tool '${toolId}'. Use tools.list_tools to see available tools.`;
    return handler(handlerCtx, args.args || {});
  });

  // Native tool definitions: per-step tools + escape hatches (always available)
  const stepDefs = manifestToNativeTools(stepManifest);
  const stepNames = new Set(stepDefs.map(d => d.function.name));
  const tools: ToolDefinition[] = [
    ...stepDefs,
    ...ESCAPE_HATCH_TOOLS.filter(d => !stepNames.has(d.function.name)),
    escalateToolDefinition(),
  ];

  return { tools, handlers };
}
