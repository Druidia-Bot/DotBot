/**
 * Centralized Logging System
 * 
 * Usage:
 * 
 * ```typescript
 * import { initLogger, log, ConsoleTransport, FileTransport } from "@dotbot/shared/logging";
 * 
 * // Initialize once at startup
 * initLogger({
 *   minLevel: "debug",
 *   component: "local-agent",
 *   transports: [
 *     new ConsoleTransport({ colors: true }),
 *     new FileTransport({ logDir: "~/.bot/logs" })
 *   ]
 * });
 * 
 * // Use anywhere
 * log().info("Starting up", { version: "1.0.0" });
 * log().error("Something failed", new Error("oops"), { context: "startup" });
 * 
 * // Create child logger with context
 * const wsLog = log().child({ component: "local-agent.ws" });
 * wsLog.debug("Connected");
 * ```
 */

// Types
export {
  LOG_LEVELS,
  DEFAULT_REDACT_PATTERNS,
  type LogLevel,
  type LogEntry,
  type LogTransport,
  type LoggerConfig,
  type ILogger,
  type WSLogMessage
} from "./types.js";

// Logger
export {
  Logger,
  initLogger,
  getLogger,
  log
} from "./logger.js";

// Transports
export {
  ConsoleTransport,
  FileTransport,
  WebSocketTransport,
  LogReceiver,
  type ConsoleTransportOptions,
  type FileTransportOptions,
  type WebSocketTransportOptions,
  type LogSubscription
} from "./transports/index.js";
