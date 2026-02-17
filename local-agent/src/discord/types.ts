/**
 * Shared Discord types used across gateway and adapter modules.
 */

export interface DiscordAttachment {
  id: string;
  filename: string;
  url: string;
  size: number;
  content_type?: string;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: {
    id: string;
    username: string;
    bot?: boolean;
  };
  content: string;
  timestamp: string;
  attachments?: DiscordAttachment[];
}

export interface DiscordInteraction {
  id: string;
  token: string;
  type: number;           // 3 = MESSAGE_COMPONENT
  channel_id: string;
  guild_id?: string;
  message?: any;          // The original message with the component
  data: {
    custom_id: string;    // The button's custom_id
    component_type: number; // 2 = Button
  };
  user: {
    id: string;
    username: string;
  };
}

export interface GatewayCallbacks {
  onMessage: (message: DiscordMessage) => void | Promise<void>;
  onInteraction?: (interaction: DiscordInteraction) => void;
  onReady: (botUserId: string) => void;
  onDisconnect: () => void;
  onError: (error: string) => void;
}

/**
 * Log verbosity levels for Discord #logs channel.
 *
 * - "full":    Every tool call, stream chunk, and lifecycle event
 * - "summary": Only lifecycle events — agent started, completed, failed
 * - "off":     Nothing sent to #logs
 *
 * Controlled by DISCORD_LOG_VERBOSITY env var. Defaults to "summary".
 */
export type DiscordLogVerbosity = "full" | "summary" | "off";
