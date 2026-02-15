/**
 * Tool Handler — memory.save_message
 *
 * Saves the user's message to a memory model. Auto-promotes from
 * deep archive if needed. Tracks side effects in ctx.state.
 */

import { createComponentLogger } from "../../logging.js";
import { sendMemoryRequest } from "../../ws/device-bridge.js";
import type { ToolContext } from "../types.js";

const log = createComponentLogger("tool-loop.memory.save_message");

export async function handleMemorySaveMessage(ctx: ToolContext, args: Record<string, any>): Promise<string> {
  const slug = args.slug || "";
  const prompt = ctx.state.userPrompt || "";

  const resurfacedModels: string[] = ctx.state.resurfacedModels || [];
  const savedToModels: string[] = ctx.state.savedToModels || [];

  // Step 1: Promote from deep archive if needed
  try {
    const promoteRes = await sendMemoryRequest(ctx.deviceId, {
      action: "promote_model",
      modelSlug: slug,
    } as any);
    if (promoteRes?.promoted) {
      resurfacedModels.push(slug);
      ctx.state.resurfacedModels = resurfacedModels;
      log.info("Auto-promoted model from archive", { slug });
    }
  } catch {
    // Not in archive or already active — fine
  }

  // Step 2: Save conversation entry to the model
  const saveRes = await sendMemoryRequest(ctx.deviceId, {
    action: "save_model",
    modelSlug: slug,
    data: {
      slug,
      conversations: [{
        role: "user",
        content: prompt,
        timestamp: new Date().toISOString(),
      }],
    },
  } as any);

  const saved = !!saveRes;
  if (saved && !savedToModels.includes(slug)) {
    savedToModels.push(slug);
    ctx.state.savedToModels = savedToModels;
  }

  log.info("save_message_to_model", { slug, saved, promoted: resurfacedModels.includes(slug) });

  return saved
    ? `Saved message to model "${slug}".${resurfacedModels.includes(slug) ? " (promoted from archive)" : ""}`
    : `Failed to save message to model "${slug}".`;
}
