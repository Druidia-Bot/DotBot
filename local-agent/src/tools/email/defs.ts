/**
 * Email Tool Definitions (temp email via mail.tm)
 */

import type { DotBotTool } from "../../memory/types.js";

export const emailTools: DotBotTool[] = [
  {
    id: "email.create_temp",
    name: "create_temp_email",
    description: "Create a temporary disposable email address via mail.tm. Returns the address and account ID. Use for signups, verifications, or receiving one-off emails. The address is valid until you delete it or the mail.tm service recycles it. Only one temp email can be active at a time.",
    source: "core",
    category: "email",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        prefix: { type: "string", description: "Optional prefix for the email address (e.g. 'dotbot-signup'). Random if omitted." },
      },
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "email.check_temp_inbox",
    name: "check_temp_inbox",
    description: "Check the inbox of the currently active temp email address. Returns a list of received messages with sender, subject, and timestamp. Use email.read_temp_message to get the full body of a specific message.",
    source: "core",
    category: "email",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number", description: "Page number for pagination (default: 1)" },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "email.read_temp_message",
    name: "read_temp_message",
    description: "Read the full content of a specific temp email message by its ID. Returns the complete body (plain text and HTML), attachments info, and all headers.",
    source: "core",
    category: "email",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "The message ID from email.check_temp_inbox results" },
      },
      required: ["message_id"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "email.delete_temp",
    name: "delete_temp_email",
    description: "Delete the currently active temp email account and all its messages. Use when done with the temp address (e.g. after verifying a signup). Frees the slot so a new temp email can be created.",
    source: "core",
    category: "email",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "email.list_addresses",
    name: "list_email_addresses",
    description: "List all active email addresses — both the identity email (@getmy.bot, if provisioned) and the temp email (mail.tm, if active). Shows address, type, creation time, and message count.",
    source: "core",
    category: "email",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: { readOnlyHint: true },
  },
];
