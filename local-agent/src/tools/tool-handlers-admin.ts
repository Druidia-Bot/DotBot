/**
 * Admin Tool Handlers
 * 
 * Handles admin.* tools by sending admin_request messages to the server
 * over WebSocket and waiting for admin_response.
 * 
 * All operations are gated server-side by isDeviceAdmin() — non-admin
 * devices get an "Unauthorized" error back.
 */

import { nanoid } from "nanoid";

interface ToolExecResult {
  success: boolean;
  output: string;
  error?: string;
}

// Server communication callback — set by tool-executor.ts
let _sendAdminRequest: ((payload: any) => Promise<any>) | null = null;

/**
 * Register the callback that sends admin_request to the server and
 * returns the admin_response payload. Called once during agent startup.
 */
export function setAdminRequestSender(sender: (payload: any) => Promise<any>): void {
  _sendAdminRequest = sender;
}

export async function handleAdmin(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  if (!_sendAdminRequest) {
    return { success: false, output: "", error: "Admin request sender not initialized — not connected to server." };
  }

  switch (toolId) {
    case "admin.create_token": {
      const response = await _sendAdminRequest({
        action: "create_token",
        maxUses: args.max_uses ?? 1,
        expiryDays: args.expiry_days ?? 7,
        label: args.label ?? "Agent-generated token",
      });
      if (!response?.success) {
        return { success: false, output: "", error: response?.error || "Failed to create token" };
      }
      const d = response.data;
      return {
        success: true,
        output: JSON.stringify({
          token: d.token,
          expiresAt: d.expiresAt,
          maxUses: d.maxUses,
          label: d.label,
          hint: "Give this token to the user who needs to register a new device. It can only be used once (unless max_uses was set higher).",
        }, null, 2),
      };
    }

    case "admin.list_tokens": {
      const response = await _sendAdminRequest({ action: "list_tokens" });
      if (!response?.success) {
        return { success: false, output: "", error: response?.error || "Failed to list tokens" };
      }
      return { success: true, output: JSON.stringify(response.data, null, 2) };
    }

    case "admin.revoke_token": {
      if (!args.token) return { success: false, output: "", error: "token is required" };
      const response = await _sendAdminRequest({ action: "revoke_token", token: args.token });
      if (!response?.success) {
        return { success: false, output: "", error: response?.error || "Failed to revoke token" };
      }
      return { success: true, output: JSON.stringify(response.data, null, 2) };
    }

    case "admin.list_devices": {
      const response = await _sendAdminRequest({ action: "list_devices" });
      if (!response?.success) {
        return { success: false, output: "", error: response?.error || "Failed to list devices" };
      }
      return { success: true, output: JSON.stringify(response.data, null, 2) };
    }

    case "admin.revoke_device": {
      if (!args.device_id) return { success: false, output: "", error: "device_id is required" };
      const response = await _sendAdminRequest({ action: "revoke_device", targetDeviceId: args.device_id });
      if (!response?.success) {
        return { success: false, output: "", error: response?.error || "Failed to revoke device" };
      }
      return { success: true, output: JSON.stringify(response.data, null, 2) };
    }

    default:
      return { success: false, output: "", error: `Unknown admin tool: ${toolId}` };
  }
}
