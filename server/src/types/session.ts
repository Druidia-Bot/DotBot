/**
 * Session & User Types
 *
 * User profiles and device session management.
 */

export interface UserProfile {
  id: string;
  email: string;
  trustLevel: "basic" | "standard" | "power";
  customPersonas?: { id: string; name: string; description: string }[];
  customPaths?: { id: string; name: string; description: string; personas: string[]; triggers: string[] }[];
  preferences: {
    defaultPath?: string;
    verbosity?: "minimal" | "normal" | "detailed";
    confirmDestructive?: boolean;
  };
  metrics: {
    successfulExecutions: number;
    failedExecutions: number;
    daysActive: number;
  };
  createdAt: Date;
}

export interface DeviceSession {
  id: string;
  userId: string;
  deviceId: string;
  deviceName: string;
  capabilities: string[];
  tempDir?: string;
  /** Client platform for V2 tool filtering. */
  platform?: "windows" | "linux" | "macos" | "web";
  /** IANA timezone reported by the client (e.g. "America/New_York"). Updated on each heartbeat. */
  timezone?: string;
  connectedAt: Date;
  lastActiveAt: Date;
  status: "connected" | "disconnected";
}
