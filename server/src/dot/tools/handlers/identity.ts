/**
 * Handlers: identity.read, identity.update, identity.remove
 */

import { sendMemoryRequest } from "#ws/device-bridge.js";
import { getDeviceForUser } from "#ws/devices.js";
import type { ToolHandler, ToolContext } from "#tool-loop/types.js";

const VALID_UPDATE_FIELDS = [
  "trait", "ethic", "conduct", "instruction",
  "communication_style", "property", "name", "role", "use_backstory",
] as const;

const VALID_REMOVE_FIELDS = [
  "trait", "ethic", "conduct", "instruction",
  "communication_style", "property",
] as const;

export function identityReadHandler(): ToolHandler {
  return async (ctx: ToolContext): Promise<string> => {
    const userId = ctx.state.userId as string;
    const deviceId = getDeviceForUser(userId);
    if (!deviceId) return "No local agent connected — cannot read identity.";

    try {
      const identity = await sendMemoryRequest(deviceId, { action: "get_identity" });
      if (!identity) return "Identity not found.";

      const lines: string[] = [
        `**Name:** ${identity.name}`,
        `**Role:** ${identity.role}`,
        `**Traits:** ${(identity.traits || []).join("; ")}`,
        `**Ethics:** ${(identity.ethics || []).join("; ")}`,
        `**Code of Conduct:** ${(identity.codeOfConduct || []).join("; ")}`,
        `**Communication Style:** ${(identity.communicationStyle || []).join(", ")}`,
      ];
      if (identity.humanInstructions?.length > 0) {
        lines.push(`**Human Instructions:** ${identity.humanInstructions.join("; ")}`);
      }
      const propKeys = Object.keys(identity.properties || {});
      if (propKeys.length > 0) {
        lines.push(`**Properties:** ${propKeys.map((k: string) => `${k}: ${identity.properties[k]}`).join("; ")}`);
      }
      const pathKeys = Object.keys(identity.importiantPaths || {});
      if (pathKeys.length > 0) {
        lines.push("**Important Paths:**");
        for (const k of pathKeys) {
          const raw = identity.importiantPaths[k];
          const [p, desc] = raw.includes(" | ") ? raw.split(" | ", 2) : [raw, ""];
          lines.push(`  ${k}: ${p}${desc ? ` — ${desc}` : ""}`);
        }
      }
      lines.push(`**Version:** ${identity.version}`);
      return lines.join("\n");
    } catch (err) {
      return `Identity read failed: ${err instanceof Error ? err.message : err}`;
    }
  };
}

export function identityUpdateHandler(): ToolHandler {
  return async (ctx: ToolContext, args: Record<string, any>): Promise<string> => {
    const userId = ctx.state.userId as string;
    const deviceId = getDeviceForUser(userId);
    if (!deviceId) return "No local agent connected — cannot update identity.";

    const { field, value, key } = args;
    if (!field || !value) return "Error: field and value are required.";

    const actionMap: Record<string, string> = {
      trait: "identity_add_trait",
      ethic: "identity_add_ethic",
      conduct: "identity_add_conduct",
      instruction: "identity_add_instruction",
      communication_style: "identity_add_communication_style",
      property: "identity_set_property",
      name: "identity_set_name",
      role: "identity_set_role",
      use_backstory: "identity_set_use_backstory",
    };

    const action = actionMap[field];
    if (!action) return `Error: invalid field "${field}". Valid: ${VALID_UPDATE_FIELDS.join(", ")}`;

    if (field === "property" && !key) {
      return "Error: 'key' is required when updating a property.";
    }

    try {
      const data = field === "property" ? { key, value } : { value };
      const result = await sendMemoryRequest(deviceId, { action, data });
      if (result === false) {
        return `No change — "${value}" may already exist in ${field}.`;
      }
      return `Identity updated: added ${field} "${value}"${field === "property" ? ` (key: ${key})` : ""}.`;
    } catch (err) {
      return `Identity update failed: ${err instanceof Error ? err.message : err}`;
    }
  };
}

export function identityRemoveHandler(): ToolHandler {
  return async (ctx: ToolContext, args: Record<string, any>): Promise<string> => {
    const userId = ctx.state.userId as string;
    const deviceId = getDeviceForUser(userId);
    if (!deviceId) return "No local agent connected — cannot update identity.";

    const { field, value } = args;
    if (!field || !value) return "Error: field and value are required.";

    const actionMap: Record<string, string> = {
      trait: "identity_remove_trait",
      ethic: "identity_remove_ethic",
      conduct: "identity_remove_conduct",
      instruction: "identity_remove_instruction",
      communication_style: "identity_remove_communication_style",
      property: "identity_remove_property",
    };

    const action = actionMap[field];
    if (!action) return `Error: invalid field "${field}". Valid: ${VALID_REMOVE_FIELDS.join(", ")}`;

    try {
      const data = field === "property" ? { key: value } : { value };
      const result = await sendMemoryRequest(deviceId, { action, data });
      if (result === false) {
        return `No change — "${value}" not found in ${field}.`;
      }
      return `Identity updated: removed ${field} "${value}".`;
    } catch (err) {
      return `Identity remove failed: ${err instanceof Error ? err.message : err}`;
    }
  };
}
