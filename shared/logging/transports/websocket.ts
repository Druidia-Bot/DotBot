/**
 * WebSocket Transport
 * 
 * Sends logs to connected clients via WebSocket.
 * Supports batching for performance.
 */

import { LogTransport, LogEntry, LogLevel } from "../types.js";

// ============================================
// WEBSOCKET TRANSPORT
// ============================================

export interface WebSocketTransportOptions {
  /** Minimum level to log */
  minLevel?: LogLevel;
  /** Function to send log entries to connected clients */
  sender: (entries: LogEntry[]) => void;
  /** Batch logs and send every N milliseconds (default: 100) */
  batchInterval?: number;
  /** Max batch size before forcing send (default: 50) */
  maxBatchSize?: number;
}

export class WebSocketTransport implements LogTransport {
  name = "websocket";
  minLevel: LogLevel;
  private sender: (entries: LogEntry[]) => void;
  private batchInterval: number;
  private maxBatchSize: number;
  private batch: LogEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: WebSocketTransportOptions) {
    this.minLevel = options.minLevel || "info";
    this.sender = options.sender;
    this.batchInterval = options.batchInterval || 100;
    this.maxBatchSize = options.maxBatchSize || 50;
  }

  log(entry: LogEntry): void {
    this.batch.push(entry);

    // Force send if batch is full
    if (this.batch.length >= this.maxBatchSize) {
      this.sendBatch();
      return;
    }

    // Start timer if not running
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.sendBatch();
      }, this.batchInterval);
    }
  }

  private sendBatch(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.batch.length === 0) return;

    const entries = this.batch;
    this.batch = [];

    try {
      this.sender(entries);
    } catch (err) {
      // Log send failure to console (don't recurse!)
      console.error("[WebSocketTransport] Failed to send logs:", err);
    }
  }

  async flush(): Promise<void> {
    this.sendBatch();
  }

  async close(): Promise<void> {
    await this.flush();
  }
}

// ============================================
// CLIENT-SIDE LOG RECEIVER
// ============================================

export interface LogSubscription {
  minLevel?: LogLevel;
  components?: string[];
  correlationId?: string;
}

export class LogReceiver {
  private logs: LogEntry[] = [];
  private maxLogs: number;
  private listeners: Set<(entry: LogEntry) => void> = new Set();
  private subscription: LogSubscription = {};

  constructor(maxLogs: number = 1000) {
    this.maxLogs = maxLogs;
  }

  /** Process incoming log entries from WebSocket */
  receive(entries: LogEntry[]): void {
    for (const entry of entries) {
      if (this.matchesSubscription(entry)) {
        this.logs.push(entry);
        if (this.logs.length > this.maxLogs) {
          this.logs.shift();
        }
        this.notifyListeners(entry);
      }
    }
  }

  private matchesSubscription(entry: LogEntry): boolean {
    const sub = this.subscription;
    
    if (sub.minLevel) {
      const levels = ["trace", "debug", "info", "warn", "error", "fatal"];
      if (levels.indexOf(entry.level) < levels.indexOf(sub.minLevel)) {
        return false;
      }
    }

    if (sub.components && sub.components.length > 0) {
      if (!sub.components.some(c => entry.component.startsWith(c))) {
        return false;
      }
    }

    if (sub.correlationId && entry.correlationId !== sub.correlationId) {
      return false;
    }

    return true;
  }

  /** Subscribe to log updates */
  subscribe(callback: (entry: LogEntry) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private notifyListeners(entry: LogEntry): void {
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch (err) {
        console.error("[LogReceiver] Listener error:", err);
      }
    }
  }

  /** Update subscription filters */
  setSubscription(sub: LogSubscription): void {
    this.subscription = sub;
  }

  /** Get all logs matching current subscription */
  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  /** Get logs filtered by criteria */
  query(options: {
    minLevel?: LogLevel;
    component?: string;
    correlationId?: string;
    since?: string;
    limit?: number;
  }): LogEntry[] {
    let results = this.logs;

    if (options.minLevel) {
      const levels = ["trace", "debug", "info", "warn", "error", "fatal"];
      const minIdx = levels.indexOf(options.minLevel);
      results = results.filter(e => levels.indexOf(e.level) >= minIdx);
    }

    if (options.component) {
      results = results.filter(e => e.component.startsWith(options.component!));
    }

    if (options.correlationId) {
      results = results.filter(e => e.correlationId === options.correlationId);
    }

    if (options.since) {
      results = results.filter(e => e.timestamp >= options.since!);
    }

    if (options.limit) {
      results = results.slice(-options.limit);
    }

    return results;
  }

  /** Clear all logs */
  clear(): void {
    this.logs = [];
  }
}
