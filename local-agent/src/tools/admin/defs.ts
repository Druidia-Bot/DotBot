/**
 * Admin Tool Definitions (server-side, WS-only)
 */

import type { DotBotTool } from "../../memory/types.js";

export const adminTools: DotBotTool[] = [
  {
    id: "admin.create_token",
    name: "create_invite_token",
    description: "Generate a new invite token for device registration. Returns the token string (dbot-XXXX-XXXX-XXXX-XXXX format) which must be given to the user who needs to register. The token is single-use by default and expires in 7 days.",
    source: "core",
    category: "admin",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Human-readable label for this token (e.g. 'Alice laptop')" },
        max_uses: { type: "number", description: "How many times this token can be used (default: 1)" },
        expiry_days: { type: "number", description: "Days until token expires (default: 7)" },
      },
    },
    annotations: { destructiveHint: true, mutatingHint: true },
  },
  {
    id: "admin.list_tokens",
    name: "list_invite_tokens",
    description: "List all invite tokens and their status (active, consumed, revoked, expired). Shows usage counts and expiry dates.",
    source: "core",
    category: "admin",
    executor: "local",
    runtime: "internal",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
  {
    id: "admin.revoke_token",
    name: "revoke_invite_token",
    description: "Revoke an active invite token so it can no longer be used for device registration.",
    source: "core",
    category: "admin",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "The full invite token string to revoke (dbot-XXXX-XXXX-XXXX-XXXX)" },
      },
      required: ["token"],
    },
    annotations: { destructiveHint: true, mutatingHint: true },
  },
  {
    id: "admin.list_devices",
    name: "list_registered_devices",
    description: "List all registered devices — shows device ID, label, status, admin flag, registration date, and last seen info.",
    source: "core",
    category: "admin",
    executor: "local",
    runtime: "internal",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
  {
    id: "admin.revoke_device",
    name: "revoke_device",
    description: "Revoke a registered device so it can no longer authenticate. The device will need a new invite token to re-register.",
    source: "core",
    category: "admin",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        device_id: { type: "string", description: "The device ID to revoke (dev_XXXX format)" },
      },
      required: ["device_id"],
    },
    annotations: { destructiveHint: true, mutatingHint: true },
  },
];
