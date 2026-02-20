/**
 * Schedule Tool Manifest
 *
 * ToolManifestEntry[] for server-side schedule tools.
 * Derived from the CoreToolDefinitions in tools/definitions/universal.ts
 * so the LLM can see and call schedule.* tools.
 */

import { schedule } from "#tools/definitions/universal.js";
import type { ToolManifestEntry } from "#tools/types.js";

export const SCHEDULE_TOOLS: ToolManifestEntry[] = schedule.map(t => ({
  id: t.id,
  name: t.name,
  description: t.description,
  category: t.category,
  inputSchema: t.inputSchema,
  ...(t.annotations && { annotations: t.annotations }),
}));
