/**
 * Console Transport
 * 
 * Outputs logs to console with color coding and formatting.
 * Works in both Node.js and browser environments.
 */

import { LogTransport, LogEntry, LogLevel, LOG_LEVELS } from "../types.js";

// ============================================
// COLOR CODES (ANSI for Node.js)
// ============================================

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  bgRed: "\x1b[41m",
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  trace: COLORS.gray,
  debug: COLORS.cyan,
  info: COLORS.blue,
  warn: COLORS.yellow,
  error: COLORS.red,
  fatal: COLORS.bgRed + COLORS.white,
  silent: COLORS.reset,
};

const LEVEL_LABELS: Record<LogLevel, string> = {
  trace: "TRC",
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR",
  fatal: "FTL",
  silent: "   ",
};

// ============================================
// CONSOLE TRANSPORT
// ============================================

export interface ConsoleTransportOptions {
  /** Minimum level to log */
  minLevel?: LogLevel;
  /** Use colors (default: true in TTY, false otherwise) */
  colors?: boolean;
  /** Show timestamps (default: true) */
  timestamps?: boolean;
  /** Show component name (default: true) */
  showComponent?: boolean;
  /** Pretty print data objects (default: true in dev) */
  prettyPrint?: boolean;
}

export class ConsoleTransport implements LogTransport {
  name = "console";
  minLevel: LogLevel;
  private colors: boolean;
  private timestamps: boolean;
  private showComponent: boolean;
  private prettyPrint: boolean;
  private isNode: boolean;

  constructor(options: ConsoleTransportOptions = {}) {
    this.minLevel = options.minLevel || "debug";
    this.isNode = typeof process !== "undefined" && process.stdout?.isTTY !== undefined;
    this.colors = options.colors ?? (this.isNode && process.stdout?.isTTY === true);
    this.timestamps = options.timestamps ?? true;
    this.showComponent = options.showComponent ?? true;
    this.prettyPrint = options.prettyPrint ?? true;
  }

  log(entry: LogEntry): void {
    const parts: string[] = [];

    // Timestamp
    if (this.timestamps) {
      const time = entry.timestamp.split("T")[1].split(".")[0]; // HH:MM:SS
      parts.push(this.colorize(time, COLORS.dim));
    }

    // Level
    const levelLabel = LEVEL_LABELS[entry.level];
    parts.push(this.colorize(levelLabel, LEVEL_COLORS[entry.level]));

    // Component
    if (this.showComponent) {
      parts.push(this.colorize(`[${entry.component}]`, COLORS.magenta));
    }

    // Correlation ID (if present)
    if (entry.correlationId) {
      parts.push(this.colorize(`(${entry.correlationId.slice(0, 8)})`, COLORS.dim));
    }

    // Message
    parts.push(entry.message);

    // Build the main line
    let output = parts.join(" ");

    // Add data if present
    if (entry.data && Object.keys(entry.data).length > 0) {
      if (this.prettyPrint) {
        output += "\n" + this.colorize(JSON.stringify(entry.data, null, 2), COLORS.dim);
      } else {
        output += " " + this.colorize(JSON.stringify(entry.data), COLORS.dim);
      }
    }

    // Add error if present
    if (entry.error) {
      output += "\n" + this.colorize(`${entry.error.name}: ${entry.error.message}`, COLORS.red);
      if (entry.error.stack) {
        output += "\n" + this.colorize(entry.error.stack, COLORS.dim);
      }
    }

    // Output to appropriate console method
    switch (entry.level) {
      case "trace":
      case "debug":
        console.debug(output);
        break;
      case "info":
        console.info(output);
        break;
      case "warn":
        console.warn(output);
        break;
      case "error":
      case "fatal":
        console.error(output);
        break;
    }
  }

  private colorize(text: string, color: string): string {
    if (!this.colors) return text;
    return `${color}${text}${COLORS.reset}`;
  }
}
