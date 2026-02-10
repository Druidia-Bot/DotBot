/**
 * Centralized Logging Types
 * 
 * Shared between local-agent, server, and client.
 * Structured logging with multiple transport support.
 */

// ============================================
// LOG LEVELS
// ============================================

export const LOG_LEVELS = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
  silent: 6
} as const;

export type LogLevel = keyof typeof LOG_LEVELS;

// ============================================
// LOG ENTRY
// ============================================

export interface LogEntry {
  /** ISO timestamp */
  timestamp: string;
  /** Log level */
  level: LogLevel;
  /** Component that produced the log (e.g., "local-agent", "server.ws", "council.gateway") */
  component: string;
  /** Human-readable message */
  message: string;
  /** Structured data payload */
  data?: Record<string, unknown>;
  /** Error details if applicable */
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  /** Correlation ID for request tracing */
  correlationId?: string;
  /** User ID if available */
  userId?: string;
  /** Session ID if available */
  sessionId?: string;
  /** Source file and line (dev only) */
  source?: {
    file: string;
    line: number;
  };
}

// ============================================
// TRANSPORT INTERFACE
// ============================================

export interface LogTransport {
  /** Transport name for debugging */
  name: string;
  /** Minimum level this transport handles */
  minLevel: LogLevel;
  /** Process a log entry */
  log(entry: LogEntry): void | Promise<void>;
  /** Flush any buffered logs (for graceful shutdown) */
  flush?(): Promise<void>;
  /** Close the transport */
  close?(): Promise<void>;
}

// ============================================
// LOGGER CONFIG
// ============================================

export interface LoggerConfig {
  /** Minimum level to log (entries below this are ignored) */
  minLevel: LogLevel;
  /** Component name for this logger instance */
  component: string;
  /** Default context to attach to all logs */
  defaultContext?: {
    userId?: string;
    sessionId?: string;
    correlationId?: string;
  };
  /** Transports to use */
  transports: LogTransport[];
  /** Fields to redact from data (regex patterns) */
  redactPatterns?: RegExp[];
  /** Keep last N logs in memory (for client fetch) */
  ringBufferSize?: number;
}

// ============================================
// LOGGER INTERFACE
// ============================================

export interface ILogger {
  trace(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, error?: Error | unknown, data?: Record<string, unknown>): void;
  fatal(message: string, error?: Error | unknown, data?: Record<string, unknown>): void;
  
  /** Create a child logger with additional context */
  child(context: { component?: string; correlationId?: string; userId?: string; sessionId?: string }): ILogger;
  
  /** Set correlation ID for request tracing */
  setCorrelationId(id: string): void;
  
  /** Get recent logs from ring buffer */
  getRecentLogs(count?: number): LogEntry[];
  
  /** Flush all transports */
  flush(): Promise<void>;
}

// ============================================
// WEBSOCKET LOG MESSAGE
// ============================================

export interface WSLogMessage {
  type: "log" | "log_batch" | "log_query" | "log_subscribe";
  payload: {
    entries?: LogEntry[];
    query?: {
      minLevel?: LogLevel;
      component?: string;
      correlationId?: string;
      since?: string;
      limit?: number;
    };
    subscribe?: {
      minLevel?: LogLevel;
      components?: string[];
    };
  };
}

// ============================================
// SENSITIVE FIELD PATTERNS
// ============================================

export const DEFAULT_REDACT_PATTERNS = [
  /apiKey/i,
  /api_key/i,
  /password/i,
  /secret/i,
  /token/i,
  /authorization/i,
  /credential/i,
  /private/i,
];
