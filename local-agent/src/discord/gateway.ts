/**
 * Discord Gateway WebSocket Client
 * 
 * Connects to Discord's Gateway API to receive real-time events.
 * Handles the full lifecycle: HELLO → IDENTIFY → READY → events.
 * Manages heartbeat, reconnect, and resume.
 * 
 * The bot token is resolved once via credential_resolve and held in
 * a closure — never exported, logged, or accessible to tools.
 */

import WebSocket from "ws";

// ============================================
// DISCORD GATEWAY OPCODES
// ============================================

const GatewayOp = {
  DISPATCH: 0,        // Server → Client: event dispatched
  HEARTBEAT: 1,       // Client → Server: heartbeat
  IDENTIFY: 2,        // Client → Server: identify with token
  RESUME: 6,          // Client → Server: resume missed events
  RECONNECT: 7,       // Server → Client: please reconnect
  INVALID_SESSION: 9, // Server → Client: session invalid
  HELLO: 10,          // Server → Client: hello + heartbeat interval
  HEARTBEAT_ACK: 11,  // Server → Client: heartbeat acknowledged
} as const;

// GUILDS (1<<0) + GUILD_MESSAGES (1<<9) + MESSAGE_CONTENT (1<<15)
const GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 15); // 33281

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const MAX_RECONNECT_DELAY_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 20;

// ============================================
// TYPES
// ============================================

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

// ============================================
// GATEWAY CLIENT
// ============================================

export class DiscordGateway {
  private token: string;
  private callbacks: GatewayCallbacks;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatJitterTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatAcked = true;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private botUserId: string | null = null;
  private reconnectAttempts = 0;
  private destroyed = false;

  constructor(token: string, callbacks: GatewayCallbacks) {
    this.token = token;
    this.callbacks = callbacks;
  }

  // ── Public API ──

  connect(): void {
    if (this.destroyed) return;

    const url = this.resumeGatewayUrl || GATEWAY_URL;
    console.log(`[Discord] Connecting to Gateway...`);

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      console.log("[Discord] Gateway WebSocket connected");
      this.reconnectAttempts = 0;
    });

    this.ws.on("message", (data) => {
      try {
        const payload = JSON.parse(data.toString());
        this.handleGatewayMessage(payload);
      } catch (err) {
        console.error("[Discord] Failed to parse Gateway message:", err);
      }
    });

    this.ws.on("close", (code, reason) => {
      console.log(`[Discord] Gateway closed: code=${code} reason="${reason.toString()}"`);
      this.stopHeartbeat();

      if (this.destroyed) return;

      // Fatal close codes — don't reconnect
      switch (code) {
        case 4004:
          console.error("[Discord] FATAL: Authentication failed — invalid token. Not reconnecting.");
          this.callbacks.onError("Discord authentication failed — invalid bot token");
          return;
        case 4013:
          console.error("[Discord] FATAL: Invalid intents value. Check GATEWAY_INTENTS constant.");
          this.callbacks.onError("Discord rejected intents — invalid value");
          return;
        case 4014:
          console.error("[Discord] FATAL: Disallowed intents. You must enable 'Message Content Intent' in the Discord Developer Portal → Bot → Privileged Gateway Intents.");
          this.callbacks.onError("Discord rejected intents — enable Message Content Intent in Developer Portal");
          return;
        case 4010:
          console.error("[Discord] FATAL: Invalid shard. Not reconnecting.");
          this.callbacks.onError("Discord rejected shard configuration");
          return;
        case 4011:
          console.error("[Discord] FATAL: Sharding required but not configured.");
          this.callbacks.onError("Discord requires sharding — bot is in too many servers");
          return;
        case 4012:
          console.error("[Discord] FATAL: Invalid API version.");
          this.callbacks.onError("Discord rejected API version");
          return;
      }

      // Close codes that require a fresh session (don't resume)
      if (code === 4007 || code === 4009) {
        this.sessionId = null;
        this.sequence = null;
      }

      this.callbacks.onDisconnect();
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      console.error("[Discord] Gateway WebSocket error:", err.message);
    });
  }

  disconnect(): void {
    this.destroyed = true;
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close(1000, "Client shutdown");
      this.ws = null;
    }
  }

  getBotUserId(): string | null {
    return this.botUserId;
  }

  // ── Gateway Message Handling ──

  private handleGatewayMessage(payload: any): void {
    const { op, t, s, d } = payload;

    // Track sequence number for heartbeat + resume
    if (s !== null && s !== undefined) {
      this.sequence = s;
    }

    switch (op) {
      case GatewayOp.HELLO:
        this.startHeartbeat(d.heartbeat_interval);
        if (this.sessionId) {
          this.sendResume();
        } else {
          this.sendIdentify();
        }
        break;

      case GatewayOp.HEARTBEAT_ACK:
        this.heartbeatAcked = true;
        break;

      case GatewayOp.DISPATCH:
        this.handleDispatch(t, d);
        break;

      case GatewayOp.RECONNECT:
        console.log("[Discord] Server requested reconnect");
        this.ws?.close(4000, "Server requested reconnect");
        break;

      case GatewayOp.INVALID_SESSION:
        console.log("[Discord] Invalid session, resumable:", d);
        if (d) {
          // Resumable — wait a bit then resume
          setTimeout(() => this.ws?.close(4000, "Resume after invalid session"), 1000 + Math.random() * 4000);
        } else {
          // Not resumable — clear session and re-identify
          this.sessionId = null;
          this.sequence = null;
          setTimeout(() => this.ws?.close(4000, "Re-identify after invalid session"), 1000 + Math.random() * 4000);
        }
        break;

      default:
        break;
    }
  }

  private handleDispatch(eventName: string, data: any): void {
    switch (eventName) {
      case "READY":
        this.sessionId = data.session_id;
        this.resumeGatewayUrl = data.resume_gateway_url || null;
        this.botUserId = data.user?.id || null;
        console.log(`[Discord] READY — session: ${this.sessionId}, bot: ${data.user?.username}#${data.user?.discriminator}`);
        if (this.botUserId) {
          this.callbacks.onReady(this.botUserId);
        }
        break;

      case "RESUMED":
        console.log("[Discord] Session resumed successfully");
        break;

      case "MESSAGE_CREATE":
        Promise.resolve(this.callbacks.onMessage({
          id: data.id,
          channel_id: data.channel_id,
          guild_id: data.guild_id,
          author: {
            id: data.author.id,
            username: data.author.username,
            bot: data.author.bot || false,
          },
          content: data.content,
          timestamp: data.timestamp,
        })).catch(err => {
          console.error("[Discord] Error in message handler:", err);
        });
        break;

      case "INTERACTION_CREATE":
        if (this.callbacks.onInteraction && data.type === 3) {
          // type 3 = MESSAGE_COMPONENT (buttons, selects)
          const user = data.member?.user || data.user;
          this.callbacks.onInteraction({
            id: data.id,
            token: data.token,
            type: data.type,
            channel_id: data.channel_id,
            guild_id: data.guild_id,
            message: data.message,
            data: {
              custom_id: data.data?.custom_id,
              component_type: data.data?.component_type,
            },
            user: {
              id: user?.id || "unknown",
              username: user?.username || "unknown",
            },
          });
        }
        break;

      default:
        // Ignore other events
        break;
    }
  }

  // ── Heartbeat ──

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatAcked = true;

    // First heartbeat after random jitter (Discord requirement)
    const jitter = Math.random() * intervalMs;
    this.heartbeatJitterTimer = setTimeout(() => {
      this.heartbeatJitterTimer = null;
      this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        if (!this.heartbeatAcked) {
          console.warn("[Discord] Heartbeat not acknowledged — zombie connection, reconnecting");
          this.ws?.close(4000, "Zombie connection");
          return;
        }
        this.heartbeatAcked = false;
        this.sendHeartbeat();
      }, intervalMs);
    }, jitter);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatJitterTimer) {
      clearTimeout(this.heartbeatJitterTimer);
      this.heartbeatJitterTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendHeartbeat(): void {
    this.sendPayload({ op: GatewayOp.HEARTBEAT, d: this.sequence });
  }

  // ── Identify / Resume ──

  private sendIdentify(): void {
    this.sendPayload({
      op: GatewayOp.IDENTIFY,
      d: {
        token: this.token,
        intents: GATEWAY_INTENTS,
        properties: {
          os: "windows",
          browser: "dotbot",
          device: "dotbot",
        },
      },
    });
  }

  private sendResume(): void {
    console.log(`[Discord] Resuming session ${this.sessionId} at sequence ${this.sequence}`);
    this.sendPayload({
      op: GatewayOp.RESUME,
      d: {
        token: this.token,
        session_id: this.sessionId,
        seq: this.sequence,
      },
    });
  }

  // ── Reconnect ──

  private scheduleReconnect(): void {
    if (this.destroyed) return;

    this.reconnectAttempts++;

    if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      console.error(`[Discord] FATAL: Exceeded ${MAX_RECONNECT_ATTEMPTS} reconnect attempts. Giving up.`);
      this.callbacks.onError("Discord Gateway connection failed after maximum reconnect attempts");
      return;
    }
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts - 1) + Math.random() * 1000,
      MAX_RECONNECT_DELAY_MS,
    );

    console.log(`[Discord] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})`);
    setTimeout(() => this.connect(), delay);
  }

  // ── Send Helper ──

  private sendPayload(payload: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }
}
