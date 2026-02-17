/**
 * Context — Identity Fetchers
 *
 * Fetches agent identity skeleton and backstory from the local agent.
 */

import { createComponentLogger } from "#logging.js";
import { sendMemoryRequest } from "#ws/device-bridge.js";
import type { MemoryRequest } from "#ws/devices.js";

const log = createComponentLogger("context.memory");

export async function fetchAgentIdentity(deviceId: string): Promise<{ skeleton: string | undefined; useBackstory: boolean }> {
  try {
    const identityResult = await sendMemoryRequest(deviceId, {
      action: "get_identity",
    } as MemoryRequest);
    if (!identityResult) return { skeleton: undefined, useBackstory: false };

    const lines: string[] = [
      `Name: ${identityResult.name}`,
      `Role: ${identityResult.role}`,
      `Traits: ${(identityResult.traits || []).join("; ")}`,
      `Ethics: ${(identityResult.ethics || []).join("; ")}`,
      `Code of Conduct: ${(identityResult.codeOfConduct || []).join("; ")}`,
      `Communication Style: ${(identityResult.communicationStyle || []).join(", ")}`,
    ];
    if (identityResult.humanInstructions?.length > 0) {
      lines.push(`Human Instructions: ${identityResult.humanInstructions.join("; ")}`);
    }
    const propKeys = Object.keys(identityResult.properties || {});
    if (propKeys.length > 0) {
      lines.push(`Properties: ${propKeys.map((k: string) => `${k}: ${identityResult.properties[k]}`).join("; ")}`);
    }
    const pathKeys = Object.keys(identityResult.importiantPaths || {});
    if (pathKeys.length > 0) {
      lines.push("Important Paths:");
      for (const k of pathKeys) {
        const raw = identityResult.importiantPaths[k];
        const [p, desc] = raw.includes(" | ") ? raw.split(" | ", 2) : [raw, ""];
        lines.push(`  ${k}: ${p}${desc ? ` — ${desc}` : ""}`);
      }
    }
    return { skeleton: lines.join("\n"), useBackstory: identityResult.useBackstory === true };
  } catch (err) {
    log.warn("Failed to fetch agent identity from local agent", { error: err });
    return { skeleton: undefined, useBackstory: false };
  }
}

export async function fetchBackstory(deviceId: string): Promise<string | undefined> {
  try {
    const result = await sendMemoryRequest(deviceId, {
      action: "get_backstory",
    } as MemoryRequest);
    if (result && typeof result === "string") return result;
    if (result && typeof result.content === "string") return result.content;
    return undefined;
  } catch (err) {
    log.warn("Failed to fetch backstory from local agent", { error: err });
    return undefined;
  }
}
