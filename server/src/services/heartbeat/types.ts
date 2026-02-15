/**
 * Heartbeat — Types
 */

export interface HeartbeatInput {
  deviceId: string;
  userId: string;
  checklist: string;
  currentTime: string;
  timezone: string;
  idleDurationMs?: number;
  consecutiveFailures?: number;
}
