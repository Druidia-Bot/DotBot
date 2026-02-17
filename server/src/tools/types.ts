/**
 * Tool Types
 *
 * Core types for the tool manifest system — shared across
 * tool registry, platform filters, manifests, and all consumers.
 */

/** Supported client platforms for tool filtering. */
export type Platform = "windows" | "linux" | "macos" | "web";

export interface ToolManifestEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  inputSchema: {
    type?: string;
    properties?: Record<string, any>;
    required?: string[];
  };
  annotations?: {
    readOnlyHint?: boolean;
    mutatingHint?: boolean;
    verificationHint?: boolean;
    destructiveHint?: boolean;
    requiresConfirmation?: boolean;
  };
  /** Which platforms this tool works on. */
  platforms?: Platform[];
  /** Credential vault reference name (e.g., "DISCORD_BOT_TOKEN"). Never contains the actual value. */
  credentialRequired?: string;
  /** Whether the required credential is configured in the local vault. Safe — boolean only. */
  credentialConfigured?: boolean;
}
