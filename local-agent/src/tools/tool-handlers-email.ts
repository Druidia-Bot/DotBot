/**
 * Tool Handlers — Email
 * 
 * Temp email management via mail.tm API.
 * Identity email (@getmy.bot) handlers will be added in Phase 2.
 * 
 * All temp email state lives locally at ~/.bot/email/temp/.
 * No server involvement — direct HTTP calls to mail.tm.
 */

import type { ToolExecResult } from "./tool-executor.js";
import {
  createTempEmail,
  checkTempInbox,
  readTempMessage,
  deleteTempEmail,
  getActiveTempEmail,
} from "../email/temp-email.js";

export async function handleEmail(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {

    // ----------------------------------------
    // email.create_temp
    // ----------------------------------------
    case "email.create_temp": {
      const prefix = args.prefix as string | undefined;

      try {
        const account = await createTempEmail(prefix);

        return {
          success: true,
          output: JSON.stringify({
            created: true,
            address: account.address,
            domain: account.domain,
            created_at: account.createdAt,
            note: "Temp email is active. Use email.check_temp_inbox to check for messages. Use email.delete_temp when done.",
          }, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    }

    // ----------------------------------------
    // email.check_temp_inbox
    // ----------------------------------------
    case "email.check_temp_inbox": {
      const page = typeof args.page === "number" ? args.page : 1;

      try {
        const account = await getActiveTempEmail();
        const messages = await checkTempInbox(page);

        return {
          success: true,
          output: JSON.stringify({
            address: account?.address || "unknown",
            messages: messages.map(m => ({
              id: m.id,
              from: m.from.address,
              from_name: m.from.name,
              subject: m.subject,
              preview: m.intro,
              has_attachments: m.hasAttachments,
              received_at: m.createdAt,
              seen: m.seen,
            })),
            total: messages.length,
            page,
            note: messages.length === 0
              ? "No messages yet. Emails may take a few seconds to arrive."
              : "Use email.read_temp_message with a message ID to read the full content.",
          }, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    }

    // ----------------------------------------
    // email.read_temp_message
    // ----------------------------------------
    case "email.read_temp_message": {
      const messageId = args.message_id;
      if (!messageId) return { success: false, output: "", error: "message_id is required." };

      try {
        const msg = await readTempMessage(messageId);

        return {
          success: true,
          output: JSON.stringify({
            id: msg.id,
            from: msg.from.address,
            from_name: msg.from.name,
            subject: msg.subject,
            body_text: msg.text.substring(0, 10_000),
            body_html_length: msg.html.join("").length,
            attachments: msg.attachments.map(a => ({
              filename: a.filename,
              content_type: a.contentType,
              size_bytes: a.size,
            })),
            received_at: msg.createdAt,
          }, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    }

    // ----------------------------------------
    // email.delete_temp
    // ----------------------------------------
    case "email.delete_temp": {
      try {
        const result = await deleteTempEmail();

        return {
          success: true,
          output: JSON.stringify({
            deleted: true,
            address: result.address,
            note: "Temp email deleted. You can create a new one with email.create_temp.",
          }, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    }

    // ----------------------------------------
    // email.list_addresses
    // ----------------------------------------
    case "email.list_addresses": {
      try {
        const tempAccount = await getActiveTempEmail();

        const addresses: any[] = [];

        // TODO: Phase 2 — add identity email from ~/.bot/email/config.json

        if (tempAccount) {
          addresses.push({
            type: "temp",
            address: tempAccount.address,
            provider: "mail.tm",
            created_at: tempAccount.createdAt,
          });
        }

        return {
          success: true,
          output: JSON.stringify({
            addresses,
            total: addresses.length,
            note: addresses.length === 0
              ? "No active email addresses. Use email.create_temp to create a disposable address."
              : undefined,
          }, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    }

    default:
      return { success: false, output: "", error: `Unknown email tool: ${toolId}` };
  }
}
