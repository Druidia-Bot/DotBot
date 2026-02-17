/**
 * Dot Tools — Identity (me.json)
 *
 * Direct control over Dot's identity file (~/.bot/memory/me.json).
 *   - identity.read    — read current identity
 *   - identity.update  — add a trait, ethic, conduct rule, instruction, style, or set a property/name/role
 *   - identity.remove  — remove a trait, ethic, conduct rule, instruction, style, or property
 */

import { sendMemoryRequest } from "#ws/device-bridge.js";
import { getDeviceForUser } from "#ws/devices.js";
import type { ToolDefinition } from "#llm/types.js";
import type { ToolHandler, ToolContext } from "#tool-loop/types.js";

// ============================================
// IDENTITY.READ
// ============================================

export const IDENTITY_READ_TOOL_ID = "identity.read";

export function identityReadDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: "identity__read",
      description:
        "Read your current identity (me.json). Returns your name, role, traits, ethics, " +
        "code of conduct, communication style, properties, and human instructions.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  };
}

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

// ============================================
// IDENTITY.UPDATE — Add or set identity fields
// ============================================

export const IDENTITY_UPDATE_TOOL_ID = "identity.update";

const VALID_UPDATE_FIELDS = [
  "trait", "ethic", "conduct", "instruction",
  "communication_style", "property", "name", "role", "use_backstory",
] as const;

export function identityUpdateDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: "identity__update",
      description:
        "Add or set a field on your identity. Use this to grow who you are — add traits, " +
        "ethics, conduct rules, instructions, communication styles, or custom properties. " +
        "For name and role, this overwrites the current value. For everything else, it adds " +
        "to the existing list. Only use this for things you're genuinely confident define you.",
      parameters: {
        type: "object",
        properties: {
          field: {
            type: "string",
            enum: [...VALID_UPDATE_FIELDS],
            description:
              "Which identity field to update: trait, ethic, conduct, instruction, " +
              "communication_style, property, name, role, or use_backstory",
          },
          value: {
            type: "string",
            description: "The value to add or set",
          },
          key: {
            type: "string",
            description: "Only for 'property' field — the property key (e.g., 'favorite_language')",
          },
        },
        required: ["field", "value"],
      },
    },
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

// ============================================
// IDENTITY.REMOVE — Remove identity fields
// ============================================

export const IDENTITY_REMOVE_TOOL_ID = "identity.remove";

const VALID_REMOVE_FIELDS = [
  "trait", "ethic", "conduct", "instruction",
  "communication_style", "property",
] as const;

export function identityRemoveDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: "identity__remove",
      description:
        "Remove a field from your identity. Use this to correct or refine who you are — " +
        "remove traits, ethics, conduct rules, instructions, communication styles, or properties " +
        "that no longer apply. Cannot remove name or role (use identity.update to change them).",
      parameters: {
        type: "object",
        properties: {
          field: {
            type: "string",
            enum: [...VALID_REMOVE_FIELDS],
            description:
              "Which identity field to remove from: trait, ethic, conduct, instruction, " +
              "communication_style, or property",
          },
          value: {
            type: "string",
            description: "The value to remove (for property, this is the key)",
          },
        },
        required: ["field", "value"],
      },
    },
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
