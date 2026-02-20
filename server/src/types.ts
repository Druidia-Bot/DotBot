/**
 * DotBot Core Types — Barrel Re-export
 *
 * This file re-exports all types from the types/ directory for backward
 * compatibility. New code can import directly from the specific module:
 *
 *   import type { WSMessage } from "./types/ws.js";
 *   import type { DeviceSession } from "./types/session.js";
 *
 * Existing imports from "./types.js" continue to work unchanged.
 */

export * from "./types/index.js";
