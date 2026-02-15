/**
 * Secrets Tool Definitions
 */

import type { DotBotTool } from "../../memory/types.js";

export const secretsTools: DotBotTool[] = [
  {
    id: "secrets.list_keys",
    name: "list_vault_keys",
    description: "List the names of all credentials in the encrypted vault (values are NEVER shown). Credentials are server-encrypted and can only be used via the server proxy.",
    source: "core",
    category: "secrets",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "secrets.delete_key",
    name: "delete_vault_key",
    description: "Remove a credential from the encrypted vault.",
    source: "core",
    category: "secrets",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Environment variable name to remove" },
      },
      required: ["key"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "secrets.prompt_user",
    name: "prompt_user_for_credential",
    description: "Opens a secure credential entry page on the server for the user to enter a sensitive credential (API key, token, etc.). The credential is encrypted server-side with domain scoping — it can ONLY be used for API calls to the specified allowed_domain. A QR code is provided so the user can enter the credential from their phone (recommended for maximum security). The LLM NEVER sees the credential value. This is the preferred way to collect credentials.",
    source: "core",
    category: "secrets",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        key_name: { type: "string", description: "Vault key name to store the credential under (e.g., 'DISCORD_BOT_TOKEN', 'OPENAI_API_KEY')" },
        prompt: { type: "string", description: "Message shown to the user on the entry page explaining what to enter and where to find it" },
        allowed_domain: { type: "string", description: "The API domain this credential will be used with (e.g., 'discord.com', 'api.openai.com'). The credential is cryptographically bound to this domain and cannot be used elsewhere." },
        title: { type: "string", description: "Entry page title (default: 'DotBot — Secure Credential Entry')" },
      },
      required: ["key_name", "prompt", "allowed_domain"],
    },
    annotations: { destructiveHint: true },
  },
];
