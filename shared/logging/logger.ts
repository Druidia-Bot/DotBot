/**
 * Core Logger Implementation
 * 
 * Structured logging with multiple transport support.
 * Works in both Node.js (local-agent, server) and browser (client).
 */

import {
  LogLevel,
  LogEntry,
  LogTransport,
  LoggerConfig,
  ILogger,
  LOG_LEVELS,
  DEFAULT_REDACT_PATTERNS
} from "./types.js";

// ============================================
// RING BUFFER
// ============================================

class RingBuffer<T> {
  private buffer: T[];
  private head = 0;
  private count = 0;

  constructor(private capacity: number) {
    this.buffer = new Array(capacity);
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  getAll(): T[] {
    if (this.count === 0) return [];
    if (this.count < this.capacity) {
      return this.buffer.slice(0, this.count);
    }
    // Buffer is full, need to reorder
    return [
      ...this.buffer.slice(this.head),
      ...this.buffer.slice(0, this.head)
    ];
  }

  getLast(n: number): T[] {
    const all = this.getAll();
    return all.slice(-n);
  }

  clear(): void {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.count = 0;
  }
}

// ============================================
// LOGGER IMPLEMENTATION
// ============================================

export class Logger implements ILogger {
  private config: LoggerConfig;
  private ringBuffer: RingBuffer<LogEntry>;
  private context: {
    correlationId?: string;
    userId?: string;
    sessionId?: string;
  };

  constructor(config: LoggerConfig) {
    this.config = {
      ...config,
      redactPatterns: config.redactPatterns || DEFAULT_REDACT_PATTERNS,
      ringBufferSize: config.ringBufferSize || 1000
    };
    this.ringBuffer = new RingBuffer(this.config.ringBufferSize!);
    this.context = { ...config.defaultContext };
  }

  // ----------------------------------------
  // Log Methods
  // ----------------------------------------

  trace(message: string, data?: Record<string, unknown>): void {
    this.log("trace", message, data);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log("debug", message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log("warn", message, data);
  }

  error(message: string, error?: Error | unknown, data?: Record<string, unknown>): void {
    this.log("error", message, data, error);
  }

  fatal(message: string, error?: Error | unknown, data?: Record<string, unknown>): void {
    this.log("fatal", message, data, error);
  }

  // ----------------------------------------
  // Core Logging
  // ----------------------------------------

  private log(
    level: LogLevel,
    message: string,
    data?: Record<string, unknown>,
    error?: Error | unknown
  ): void {
    // Check minimum level
    if (LOG_LEVELS[level] < LOG_LEVELS[this.config.minLevel]) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component: this.config.component,
      message,
      correlationId: this.context.correlationId,
      userId: this.context.userId,
      sessionId: this.context.sessionId
    };

    // Add data (redacted)
    if (data) {
      entry.data = this.redact(data);
    }

    // Add error details
    if (error) {
      if (error instanceof Error) {
        entry.error = {
          name: error.name,
          message: error.message,
          stack: error.stack
        };
      } else {
        entry.error = {
          name: "Unknown",
          message: String(error)
        };
      }
    }

    // Store in ring buffer
    this.ringBuffer.push(entry);

    // Send to transports
    for (const transport of this.config.transports) {
      if (LOG_LEVELS[level] >= LOG_LEVELS[transport.minLevel]) {
        try {
          transport.log(entry);
        } catch (e) {
          // Transport error - log to console as fallback
          console.error(`[Logger] Transport ${transport.name} failed:`, e);
        }
      }
    }
  }

  // ----------------------------------------
  // Redaction
  // ----------------------------------------

  private redact(data: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    
    for (const [key, value] of Object.entries(data)) {
      // Check if key matches redact patterns
      const shouldRedact = this.config.redactPatterns!.some(pattern => 
        pattern.test(key)
      );
      
      if (shouldRedact) {
        result[key] = "[REDACTED]";
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        result[key] = this.redact(value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }
    
    return result;
  }

  // ----------------------------------------
  // Context Management
  // ----------------------------------------

  child(context: {
    component?: string;
    correlationId?: string;
    userId?: string;
    sessionId?: string;
  }): ILogger {
    return new Logger({
      ...this.config,
      component: context.component || this.config.component,
      defaultContext: {
        ...this.context,
        ...context
      }
    });
  }

  setCorrelationId(id: string): void {
    this.context.correlationId = id;
  }

  // ----------------------------------------
  // Buffer Access
  // ----------------------------------------

  getRecentLogs(count: number = 100): LogEntry[] {
    return this.ringBuffer.getLast(count);
  }

  // ----------------------------------------
  // Lifecycle
  // ----------------------------------------

  async flush(): Promise<void> {
    const flushPromises = this.config.transports
      .filter(t => t.flush)
      .map(t => t.flush!());
    await Promise.all(flushPromises);
  }

  async close(): Promise<void> {
    await this.flush();
    const closePromises = this.config.transports
      .filter(t => t.close)
      .map(t => t.close!());
    await Promise.all(closePromises);
  }
}

// ============================================
// GLOBAL LOGGER SINGLETON
// ============================================

let globalLogger: Logger | null = null;

export function initLogger(config: LoggerConfig): Logger {
  globalLogger = new Logger(config);
  return globalLogger;
}

export function getLogger(): Logger {
  if (!globalLogger) {
    throw new Error("Logger not initialized. Call initLogger() first.");
  }
  return globalLogger;
}

export function log(): Logger {
  return getLogger();
}
