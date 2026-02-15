/**
 * Heartbeat — Core Orchestrator
 *
 * Runs the heartbeat check: loads persona, delegates prompt building,
 * tool resolution, LLM execution, and result parsing to focused modules.
 *
 * No WS transport concerns — called by the thin handler in ws/heartbeat-handler.ts.
 */

import { createComponentLogger } from "#logging.js";
import type { HeartbeatResult } from "../../types.js";
import type { HeartbeatInput } from "./types.js";
import { buildHeartbeatPrompt } from "./prompt-builder.js";
import { resolveHeartbeatTools } from "./tool-resolver.js";
import { buildHeartbeatResult } from "./result-parser.js";

const log = createComponentLogger("heartbeat");

const FALLBACK_ASSISTANT_PROMPT = `You are a personal assistant running a periodic heartbeat check.
Check for due reminders and urgent items. If nothing needs the user's attention, reply with exactly HEARTBEAT_OK.
If something is urgent, write a concise 2-3 sentence notification.`;

/**
 * Run the heartbeat check. Returns a structured HeartbeatResult.
 * Handles both tool-enabled and LLM-only paths.
 */
export async function runHeartbeat(input: HeartbeatInput): Promise<HeartbeatResult> {
  const {
    deviceId, userId, checklist, currentTime, timezone,
    idleDurationMs, consecutiveFailures,
  } = input;

  const startTime = Date.now();

  const { createClientForSelection } = await import("#llm/factory.js");
  const { selectModel } = await import("#llm/selection/model-selector.js");
  const { getPersona } = await import("../../personas/loader.js");
  const { runToolLoop, buildProxyHandlers } = await import("#tool-loop/index.js");
  const { manifestToNativeTools } = await import("#tools/manifest.js");

  // Use personal-assistant persona with workhorse model (fast + cheap)
  const persona = getPersona("personal-assistant");
  const systemPrompt = persona?.systemPrompt || FALLBACK_ASSISTANT_PROMPT;

  const modelConfig = selectModel({ explicitRole: "workhorse" });
  const llm = createClientForSelection(modelConfig, deviceId);

  // Build context-enriched prompt
  const { userMessage, dueTasks, scheduledTasks } = await buildHeartbeatPrompt({
    checklist, currentTime, timezone, idleDurationMs, consecutiveFailures, userId,
  });

  // Resolve available tools
  const toolManifest = await resolveHeartbeatTools(deviceId, persona?.tools);

  let responseContent: string;

  if (toolManifest.length > 0) {
    // Run with clean tool loop + proxy handlers
    const handlers = buildProxyHandlers(toolManifest);
    const nativeTools = manifestToNativeTools(toolManifest) || [];
    const result = await runToolLoop({
      client: llm,
      model: modelConfig.model,
      maxTokens: 1024,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      tools: nativeTools,
      handlers,
      maxIterations: 3,
      context: { deviceId, state: {} },
      personaId: "personal-assistant",
    });
    responseContent = result.finalContent;
  } else {
    // Fallback: LLM-only (no tools available)
    const response = await llm.chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      {
        model: modelConfig.model,
        maxTokens: 1024,
        temperature: 0.2,
      },
    );
    responseContent = response.content;
  }

  return buildHeartbeatResult(
    responseContent, dueTasks, scheduledTasks,
    startTime, modelConfig.model, toolManifest.length > 0,
  );
}
