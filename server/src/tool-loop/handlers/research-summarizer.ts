/**
 * Research Summarizer — Background LLM Extraction
 *
 * Takes a large research result and extracts key facts via a cheap
 * LLM call (intake model). Saves the summary alongside the raw file
 * in the workspace. Designed to be called fire-and-forget.
 *
 * The LLM client is pulled from ctx.state.llmClient, which the step
 * executor sets before the tool loop starts.
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "#logging.js";
import { sendExecutionCommand } from "#ws/device-bridge.js";
import type { ToolContext } from "../types.js";
import type { ILLMClient } from "#llm/types.js";

const log = createComponentLogger("tool-loop.research-summarizer");

/** Max characters to send to the summarizer (avoid blowing up a cheap model). */
const MAX_SUMMARIZER_INPUT_CHARS = 30_000;

/**
 * Summarize a large research result via the intake model and save
 * the summary to the given path. Fire-and-forget — caller should
 * `.catch()` the returned promise.
 */
export async function summarizeAndSave(
  ctx: ToolContext,
  rawResult: string,
  toolId: string,
  summaryPath: string,
): Promise<void> {
  const llmClient = ctx.state.llmClient as ILLMClient | undefined;
  if (!llmClient) {
    log.debug("No LLM client in context, skipping summarization", { toolId });
    return;
  }

  try {
    const { resolveModelAndClient } = await import("#llm/resolve.js");
    const { selectedModel, client } = await resolveModelAndClient(llmClient, {
      explicitRole: "intake",
    });

    const inputText = rawResult.length > MAX_SUMMARIZER_INPUT_CHARS
      ? rawResult.substring(0, MAX_SUMMARIZER_INPUT_CHARS) + "\n\n...[truncated for summarization]"
      : rawResult;

    const response = await client.chat(
      [{
        role: "user",
        content: `Extract the key facts, data points, and actionable information from the following research result. Output a concise bullet-point summary. Focus on specifics (names, numbers, dates, URLs) — skip filler.\n\n---\n\n${inputText}`,
      }],
      {
        model: selectedModel.model,
        maxTokens: 2048,
        temperature: 0.1,
      },
    );

    const summary = response.content || "(no summary generated)";

    await sendExecutionCommand(ctx.deviceId, {
      id: `research_summary_${nanoid(6)}`,
      type: "tool_execute",
      payload: {
        toolId: "filesystem.create_file",
        toolArgs: { path: summaryPath, content: `# Summary: ${toolId}\n\n${summary}` },
      },
      dryRun: false,
      timeout: 10_000,
      sandboxed: false,
      requiresApproval: false,
    });

    log.info("Saved research summary", {
      toolId,
      summaryPath,
      summaryChars: summary.length,
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
    });
  } catch (err) {
    log.warn("Background summarization failed", { toolId, error: err });
  }
}
