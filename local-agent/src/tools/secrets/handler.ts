/**
 * Secrets Tool Handler
 */

import type { ToolExecResult } from "../_shared/types.js";
import { vaultHas, vaultList, vaultDelete } from "../../credential-vault.js";

export async function handleSecrets(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "secrets.list_keys": {
      const vaultKeys = await vaultList();

      if (vaultKeys.length === 0) return { success: true, output: "No credentials stored." };

      const lines = vaultKeys.map(key => `  ${key} — vault (server-encrypted)`);
      return { success: true, output: `${vaultKeys.length} credentials:\n${lines.join("\n")}\n\nNote: Values are NEVER shown. Credentials are server-encrypted and can only be used via the server proxy.` };
    }
    case "secrets.delete_key": {
      const deleted = await vaultDelete(args.key);
      if (!deleted) {
        return { success: true, output: `Key ${args.key} not found in vault.` };
      }
      return { success: true, output: `Deleted ${args.key} from encrypted vault.` };
    }
    case "secrets.prompt_user": {
      if (!args.key_name) return { success: false, output: "", error: "key_name is required (e.g., 'DISCORD_BOT_TOKEN')" };
      if (!args.prompt) return { success: false, output: "", error: "prompt text is required (shown to the user in the dialog)" };
      if (!args.allowed_domain) return { success: false, output: "", error: "allowed_domain is required (e.g., 'discord.com') — credentials must be scoped to a specific API domain" };

      const title = args.title || "DotBot — Secure Credential Entry";

      // Split-knowledge architecture:
      // 1. Request a secure entry page session from the server (scoped to allowed_domain)
      // 2. Show user a QR code — they scan with their phone and enter on a SEPARATE device
      // 3. User enters credential on the server's page (never on this machine)
      // 4. Server encrypts with server-side key + domain, sends opaque blob via WS
      // 5. We store the blob in vault — can NEVER decrypt it locally
      // 6. When a tool needs the credential, we send the blob to the server for proxied execution
      // → The real credential NEVER exists in plaintext on the client
      // → The credential is cryptographically bound to the allowed domain

      try {
        const { requestCredentialSession, waitForCredentialStored } = await import("../../credential-proxy.js");

        // Step 1: Request a session from the server (domain-scoped)
        const session = await requestCredentialSession(args.key_name, args.prompt, args.allowed_domain, title);

        // Step 2: Also try to open in local browser as fallback
        try {
          const parsed = new URL(session.url);
          if (parsed.protocol === "http:" || parsed.protocol === "https:") {
            const { execFile } = await import("child_process");
            execFile("cmd", ["/c", "start", "", session.url], { windowsHide: true });
          }
        } catch {
          // If browser open fails, QR code is the primary path anyway
        }

        // Step 3: Wait for the server to send us the encrypted blob
        // (user enters credential on the web page → server encrypts → sends blob via WS)
        const blob = await waitForCredentialStored(args.key_name);

        // Step 4: Store the server-encrypted blob in vault
        const { vaultSetServerBlob } = await import("../../credential-vault.js");
        await vaultSetServerBlob(args.key_name, blob);

        return {
          success: true,
          output: [
            `Credential "${args.key_name}" has been securely stored in the encrypted vault.`,
            `The value was entered on a secure server page and encrypted with a server-side key.`,
            `The credential is cryptographically bound to "${args.allowed_domain}" — it can ONLY be used for API calls to that domain.`,
            `The real credential NEVER existed in plaintext on this machine — only an opaque encrypted blob is stored locally. The LLM never sees it.`,
          ].join(" "),
        };
      } catch (err: any) {
        if (err.message?.includes("timed out")) {
          return { success: false, output: "", error: "Credential entry timed out (15 minute limit). The user did not complete the entry page. Ask if they need more time or help." };
        }
        if (err.message?.includes("not initialized")) {
          return { success: false, output: "", error: "Cannot open credential entry — server connection not established." };
        }
        return { success: false, output: "", error: `Credential entry failed: ${err.message}` };
      }
    }
    default:
      return { success: false, output: "", error: `Unknown secrets tool: ${toolId}` };
  }
}
