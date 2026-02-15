/**
 * Tool Handler — memory.get_model_field
 *
 * Retrieves a single field from a memory model, properly flattened.
 */

import { createComponentLogger } from "../../logging.js";
import { sendMemoryRequest } from "../../ws/device-bridge.js";
import type { ToolContext } from "../types.js";

const log = createComponentLogger("tool-loop.memory.get_model_field");

export async function handleMemoryGetModelField(ctx: ToolContext, args: Record<string, any>): Promise<string> {
  const model = await sendMemoryRequest(ctx.deviceId, {
    action: "get_model_detail",
    modelSlug: args.slug || "",
  } as any);

  if (!model) {
    log.info("get_model_field", { slug: args.slug, field: args.field, found: false });
    return `Model "${args.slug}" not found.`;
  }

  const field = args.field || "";
  const value = (model as any)[field];

  log.info("get_model_field", { slug: args.slug, field: args.field, found: true });

  if (value === undefined) {
    return `Field "${field}" not found on model "${args.slug}". Available: ${Object.keys(model).join(", ")}`;
  }

  return JSON.stringify(value, null, 2).slice(0, 6000);
}
