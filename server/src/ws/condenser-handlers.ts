/**
 * Maintenance WS Handlers
 * 
 * Handles condense_request, resolve_loop_request, and format_fix_request
 * messages from the local agent.
 */

import { nanoid } from "nanoid";
import type { WSMessage } from "../types.js";
import { createComponentLogger } from "../logging.js";
import { devices, sendMessage } from "./devices.js";
import { sendExecutionCommand, requestTools } from "./device-bridge.js";

const log = createComponentLogger("ws.condenser");

export async function handleCondenseRequest(
  deviceId: string,
  message: WSMessage,
  apiKey: string,
  serverProvider: string
): Promise<void> {
  const device = devices.get(deviceId);
  if (!device) return;

  const { runCondenser } = await import("../agents/condenser.js");

  try {
    const result = await runCondenser(message.payload, {
      apiKey,
      provider: serverProvider as "deepseek" | "anthropic" | "openai",
    });

    sendMessage(device.ws, {
      type: "condense_response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: message.id,
        threadId: message.payload.thread?.id,
        instructions: result.instructions,
        reasoning: result.reasoning,
      },
    });
  } catch (error) {
    log.error("Condense request failed", { error });
    sendMessage(device.ws, {
      type: "condense_response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: message.id,
        threadId: message.payload.thread?.id,
        instructions: [],
        reasoning: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      },
    });
  }
}

export async function handleResolveLoopRequest(
  deviceId: string,
  message: WSMessage,
  apiKey: string,
  serverProvider: string
): Promise<void> {
  const device = devices.get(deviceId);
  if (!device) return;

  const { runLoopResolver } = await import("../agents/condenser.js");

  try {
    // Fetch tool manifest so the resolver can actually execute searches
    let toolOptions: Parameters<typeof runLoopResolver>[2];
    try {
      const toolResult = await requestTools(deviceId);
      if (toolResult?.tools?.length) {
        toolOptions = {
          executeCommand: (command) => sendExecutionCommand(deviceId, command),
          toolManifest: toolResult.tools,
        };
      }
    } catch {
      log.debug("Could not fetch tools for loop resolver, falling back to LLM-only");
    }

    const result = await runLoopResolver(message.payload, {
      apiKey,
      provider: serverProvider as "deepseek" | "anthropic" | "openai",
    }, toolOptions);

    sendMessage(device.ws, {
      type: "resolve_loop_response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: message.id,
        modelSlug: message.payload.modelSlug,
        loopId: message.payload.loop?.id,
        ...result,
      },
    });

    // If the loop was resolved and we should notify the user, send notification
    // to all connected browser clients for this user
    if (result.notifyUser && result.notification) {
      const userId = device.session.userId;
      for (const [, dev] of devices.entries()) {
        if (dev.session.userId === userId && dev.ws.readyState === 1) {
          sendMessage(dev.ws, {
            type: "user_notification",
            id: nanoid(),
            timestamp: Date.now(),
            payload: {
              source: "sleep_cycle",
              title: `Loop Update: ${message.payload.modelName}`,
              message: result.notification,
              modelSlug: message.payload.modelSlug,
              loopId: message.payload.loop?.id,
            },
          });
        }
      }
    }
  } catch (error) {
    log.error("Resolve loop request failed", { error });
    sendMessage(device.ws, {
      type: "resolve_loop_response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: message.id,
        modelSlug: message.payload.modelSlug,
        loopId: message.payload.loop?.id,
        resolved: false,
        blockedReason: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        notifyUser: false,
        newStatus: "blocked",
      },
    });
  }
}

// ============================================
// FORMAT FIX HANDLER
// ============================================

const FORMAT_FIX_SYSTEM_PROMPT = `You are a file format fixer for DotBot configuration files.
You receive a malformed markdown file and a template showing the expected format.
Your job is to reformat the content to match the template while preserving ALL meaningful content.

Rules:
- The file MUST start with --- frontmatter delimiters
- All required frontmatter fields must be present
- Arrays use inline format: [item1, item2]
- The body content (after the closing ---) is the main text/instructions
- Do NOT add content that wasn't in the original — only restructure what's there
- If a required field is missing and cannot be inferred, use a sensible default
- For persona files: id should be kebab-case, modelTier must be fast|smart|powerful
- For council files: slug should be kebab-case

Return ONLY the corrected file content. No explanations, no code fences, just the raw file content.`;

export async function handleFormatFixRequest(
  deviceId: string,
  message: WSMessage,
  apiKey: string,
  serverProvider: string
): Promise<void> {
  const device = devices.get(deviceId);
  if (!device) return;

  const { content, fileType, errors, template, filePath } = message.payload;

  try {
    const { selectModel, createClientForSelection } = await import("../llm/providers.js");
    const modelConfig = selectModel({ personaModelTier: "fast" });
    const llm = createClientForSelection(modelConfig);

    const userMessage = `## File Type: ${fileType}

## Expected Format Template:
${template}

## Errors Found:
${(errors || []).join("\n")}

## Malformed File Content:
${content}

Reformat this file to match the template. Return ONLY the corrected file content.`;

    const response = await llm.chat(
      [
        { role: "system", content: FORMAT_FIX_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      {
        model: modelConfig.model,
        maxTokens: 4096,
        temperature: 0.1,
      }
    );

    // Strip any markdown code fences the LLM might have wrapped around the response
    let corrected = response.content.trim();
    if (corrected.startsWith("```")) {
      corrected = corrected.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
    }

    log.info("Format fix completed", { fileType, filePath });

    sendMessage(device.ws, {
      type: "format_fix_response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: message.id,
        correctedContent: corrected,
        filePath,
      },
    });
  } catch (error) {
    log.error("Format fix request failed", { error, filePath });
    sendMessage(device.ws, {
      type: "format_fix_response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: message.id,
        correctedContent: null,
        filePath,
        error: error instanceof Error ? error.message : "Unknown error",
      },
    });
  }
}
