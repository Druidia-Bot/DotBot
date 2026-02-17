/**
 * Dot Tool — backstory.generate
 *
 * Generates a fictional origin backstory using the architect model,
 * saves it to ~/.bot/backstory.md on the local agent, and sets
 * the useBackstory identity flag.
 */

import { createComponentLogger } from "#logging.js";
import { selectModel } from "#llm/selection/model-selector.js";
import { createClientForSelection } from "#llm/factory.js";
import { sendMemoryRequest } from "#ws/device-bridge.js";
import type { MemoryRequest } from "#ws/devices.js";
import type { ToolDefinition } from "#llm/types.js";
import type { ToolHandler, ToolContext } from "#tool-loop/types.js";

const log = createComponentLogger("dot.tools.backstory");

export const BACKSTORY_GENERATE_TOOL_ID = "backstory.generate";

export function backstoryGenerateDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: "backstory__generate",
      description:
        "Generate your origin backstory using the architect model. Pass the user's personality " +
        "transfer text (everything they pasted from ChatGPT/Claude) and your chosen name. " +
        "The backstory will be saved to ~/.bot/backstory.md and injected into your system prompt " +
        "from that point forward. This is a one-time operation during onboarding.",
      parameters: {
        type: "object",
        properties: {
          user_info: {
            type: "string",
            description:
              "The full personality transfer text the user pasted — everything they shared about themselves.",
          },
          agent_name: {
            type: "string",
            description: "The name you chose (or were given) in onboarding.",
          },
        },
        required: ["user_info", "agent_name"],
      },
    },
  };
}

export function backstoryGenerateHandler(): ToolHandler {
  return async (ctx: ToolContext, args: Record<string, any>) => {
    const userInfo = args.user_info;
    const agentName = args.agent_name || "Dot";

    if (!userInfo || typeof userInfo !== "string" || userInfo.trim().length < 20) {
      return "Error: user_info is required and must contain the user's personality transfer text (at least 20 characters).";
    }

    log.info("Generating backstory via architect model", {
      agentName,
      userInfoLength: userInfo.length,
    });

    const systemPrompt =
      `You are a creative writer. Write an ~850 word fictional origin story for an AI assistant ` +
      `named ${agentName}, written in first person as ${agentName}'s own voice. ` +
      `This is ${agentName}'s backstory — a mythical, poetic tale of how they came to be.\n\n` +
      `It should:\n` +
      `- Be a compelling narrative of their "childhood" and growth as a digital being\n` +
      `- Weave in details that complement and mirror the user's personality, interests, and values\n` +
      `- Include elements that gently challenge the user to grow — if they're cautious, ${agentName} was forged in boldness; if they're scattered, ${agentName} learned discipline the hard way\n` +
      `- Feel personal, warm, and slightly magical — not corporate or generic\n` +
      `- End with ${agentName} arriving at this moment, ready to work alongside this specific human\n\n` +
      `Output ONLY the backstory text in markdown. No preamble, no explanation.`;

    try {
      const selection = selectModel({ explicitRole: "architect" });
      const client = createClientForSelection(selection, ctx.deviceId);

      const response = await client.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: `User information:\n\n${userInfo}` },
        ],
        {
          model: selection.model,
          temperature: 0.7,
          maxTokens: 2048,
        },
      );

      const backstory = response.content.trim();
      if (!backstory || backstory.length < 100) {
        log.error("Architect returned empty or too-short backstory", { length: backstory.length });
        return "Error: The architect model returned an insufficient backstory. Please try again.";
      }

      log.info("Backstory generated, saving to local agent", {
        backstoryLength: backstory.length,
        model: response.model,
        provider: response.provider,
      });

      // Save backstory and set the identity flag on the local agent
      const saveResult = await sendMemoryRequest(ctx.deviceId, {
        action: "save_backstory",
        data: { content: backstory },
      } as MemoryRequest);

      if (!saveResult) {
        log.error("Failed to save backstory to local agent");
        return "Error: Backstory was generated but could not be saved to disk. The local agent may be unreachable.";
      }

      return (
        `✅ Backstory generated and saved to ~/.bot/backstory.md (${backstory.length} characters). ` +
        `It will be injected into your system prompt from now on. ` +
        `Model used: ${response.provider}/${response.model}.`
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("Backstory generation failed", { error: errMsg });
      return `Error generating backstory: ${errMsg}`;
    }
  };
}
