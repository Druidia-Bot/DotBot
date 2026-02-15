/**
 * Tool Handler — memory.get_model_detail
 *
 * Retrieves the full detail of a memory model.
 */

import { createComponentLogger } from "#logging.js";
import { sendMemoryRequest } from "#ws/device-bridge.js";
import type { ToolContext } from "../types.js";

const log = createComponentLogger("tool-loop.memory.get_model_detail");

export async function handleMemoryGetModelDetail(ctx: ToolContext, args: Record<string, any>): Promise<string> {
  const model = await sendMemoryRequest(ctx.deviceId, {
    action: "get_model_detail",
    modelSlug: args.slug || "",
  } as any);

  log.info("get_model_detail", { slug: args.slug, found: !!model });

  return model
    ? JSON.stringify(model, null, 2).slice(0, 6000)
    : `Model "${args.slug}" not found.`;
}
