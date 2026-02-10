/**
 * Logging Setup for Local Agent
 * 
 * Initializes the centralized logging system with appropriate transports.
 */

import * as path from "path";
import * as os from "os";
import {
  initLogger,
  log,
  Logger,
  ILogger,
  ConsoleTransport,
  FileTransport,
  WebSocketTransport,
  LogEntry,
  LogLevel
} from "@dotbot/shared/logging";

// ============================================
// CONFIGURATION
// ============================================

const LOG_DIR = path.join(os.homedir(), ".bot", "logs");

export interface LoggingOptions {
  /** Minimum level to log (default: "debug" in dev, "info" in prod) */
  minLevel?: LogLevel;
  /** Enable console output (default: true) */
  console?: boolean;
  /** Enable file output (default: true) */
  file?: boolean;
  /** Enable WebSocket output to client (default: true when connected) */
  websocket?: boolean;
  /** Console colors (default: auto-detect) */
  colors?: boolean;
}

// ============================================
// WEBSOCKET SENDER
// ============================================

let wsSender: ((entries: LogEntry[]) => void) | null = null;

/**
 * Set the WebSocket sender function for log streaming.
 * Call this when WebSocket connects.
 */
export function setLogWebSocketSender(sender: (entries: LogEntry[]) => void): void {
  wsSender = sender;
}

/**
 * Clear the WebSocket sender (call on disconnect).
 */
export function clearLogWebSocketSender(): void {
  wsSender = null;
}

// ============================================
// INITIALIZATION
// ============================================

let logger: Logger | null = null;

/**
 * Initialize the logging system for local-agent.
 */
export function initLocalAgentLogging(options: LoggingOptions = {}): Logger {
  const isDev = process.env.NODE_ENV !== "production";
  const minLevel = options.minLevel || (isDev ? "debug" : "info");

  const transports = [];

  // Console transport
  if (options.console !== false) {
    transports.push(new ConsoleTransport({
      minLevel: minLevel,
      colors: options.colors,
      prettyPrint: isDev
    }));
  }

  // File transport
  if (options.file !== false) {
    transports.push(new FileTransport({
      minLevel: "debug", // Always log debug+ to file
      logDir: LOG_DIR,
      filename: "local-agent",
      maxSize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5
    }));
  }

  // WebSocket transport (sends to client)
  if (options.websocket !== false) {
    transports.push(new WebSocketTransport({
      minLevel: "info", // Only send info+ to client by default
      sender: (entries: LogEntry[]) => {
        if (wsSender) {
          wsSender(entries);
        }
      },
      batchInterval: 100,
      maxBatchSize: 50
    }));
  }

  logger = initLogger({
    minLevel,
    component: "local-agent",
    transports,
    ringBufferSize: 1000
  });

  return logger;
}

/**
 * Get the logger instance.
 * Throws if not initialized.
 */
export function getLocalLogger(): Logger {
  if (!logger) {
    throw new Error("Logger not initialized. Call initLocalAgentLogging() first.");
  }
  return logger;
}

// Re-export log() for convenience
export { log };

// ============================================
// HELPER: Replace console.log calls
// ============================================

/**
 * Create a namespaced logger for a specific component.
 * 
 * Usage:
 * ```typescript
 * const wsLog = createComponentLogger("ws");
 * wsLog.info("Connected"); // logs as [local-agent.ws]
 * ```
 */
export function createComponentLogger(component: string): ILogger {
  return getLocalLogger().child({ component: `local-agent.${component}` });
}
