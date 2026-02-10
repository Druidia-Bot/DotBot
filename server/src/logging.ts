/**
 * Logging Setup for Cloud Server
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

const LOG_DIR = process.env.LOG_DIR || path.join(os.homedir(), ".bot", "server-logs");

export interface LoggingOptions {
  /** Minimum level to log (default: "debug" in dev, "info" in prod) */
  minLevel?: LogLevel;
  /** Enable console output (default: true) */
  console?: boolean;
  /** Enable file output (default: true) */
  file?: boolean;
  /** Console colors (default: auto-detect) */
  colors?: boolean;
}

// ============================================
// CLIENT LOG BROADCASTING
// ============================================

type LogBroadcaster = (entries: LogEntry[]) => void;
let broadcaster: LogBroadcaster | null = null;

/**
 * Set the function to broadcast logs to connected clients.
 */
export function setLogBroadcaster(fn: LogBroadcaster): void {
  broadcaster = fn;
}

/**
 * Clear the broadcaster.
 */
export function clearLogBroadcaster(): void {
  broadcaster = null;
}

// ============================================
// INITIALIZATION
// ============================================

let logger: Logger | null = null;

/**
 * Initialize the logging system for the server.
 */
export function initServerLogging(options: LoggingOptions = {}): Logger {
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
      minLevel: "debug",
      logDir: LOG_DIR,
      filename: "server",
      maxSize: 10 * 1024 * 1024,
      maxFiles: 10
    }));
  }

  // WebSocket transport (broadcasts to all connected clients)
  transports.push(new WebSocketTransport({
    minLevel: "info",
    sender: (entries: LogEntry[]) => {
      if (broadcaster) {
        broadcaster(entries);
      }
    },
    batchInterval: 100,
    maxBatchSize: 50
  }));

  logger = initLogger({
    minLevel,
    component: "server",
    transports,
    ringBufferSize: 2000
  });

  return logger;
}

/**
 * Get the server logger instance. Auto-initializes if not already done.
 */
export function getServerLogger(): Logger {
  if (!logger) {
    // Auto-initialize with defaults if accessed before explicit init
    initServerLogging();
  }
  return logger!;
}

// Re-export log() for convenience
export { log };

/**
 * Create a namespaced logger for a specific component.
 */
export function createComponentLogger(component: string): ILogger {
  return getServerLogger().child({ component: `server.${component}` });
}
