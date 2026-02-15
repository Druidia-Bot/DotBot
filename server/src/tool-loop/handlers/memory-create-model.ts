/**
 * Tool Handler — memory.create_model
 *
 * Creates a new memory model. Tracks the new slug in ctx.state.
 */

import { createComponentLogger } from "../../logging.js";
import { sendMemoryRequest } from "../../ws/device-bridge.js";
import type { ToolContext } from "../types.js";

const log = createComponentLogger("tool-loop.memory.create_model");

export async function handleMemoryCreateModel(ctx: ToolContext, args: Record<string, any>): Promise<string> {
  const res = await sendMemoryRequest(ctx.deviceId, {
    action: "create_model",
    data: {
      name: args.name || "Untitled",
      category: args.category || "topic",
      description: args.description || "",
    },
  } as any);

  if (res?.slug) {
    const newModelsCreated: string[] = ctx.state.newModelsCreated || [];
    newModelsCreated.push(res.slug);
    ctx.state.newModelsCreated = newModelsCreated;
    log.info("create_model", { name: args.name, slug: res.slug });
    return `Created model "${args.name}" → slug: ${res.slug}`;
  }

  log.info("create_model failed", { name: args.name });
  return `Failed to create model "${args.name}".`;
}
