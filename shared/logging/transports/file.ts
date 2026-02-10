/**
 * File Transport
 * 
 * Writes logs to files with automatic rotation.
 * Node.js only.
 */

import * as fs from "fs";
import * as path from "path";
import { LogTransport, LogEntry, LogLevel } from "../types.js";

// ============================================
// FILE TRANSPORT
// ============================================

export interface FileTransportOptions {
  /** Minimum level to log */
  minLevel?: LogLevel;
  /** Directory to write log files */
  logDir: string;
  /** Base filename (default: "dotbot") */
  filename?: string;
  /** Max file size in bytes before rotation (default: 10MB) */
  maxSize?: number;
  /** Max number of rotated files to keep (default: 5) */
  maxFiles?: number;
  /** Write as JSON lines (default: true) */
  jsonFormat?: boolean;
}

export class FileTransport implements LogTransport {
  name = "file";
  minLevel: LogLevel;
  private logDir: string;
  private filename: string;
  private maxSize: number;
  private maxFiles: number;
  private jsonFormat: boolean;
  private currentPath: string;
  private writeStream: fs.WriteStream | null = null;
  private currentSize = 0;
  private writeQueue: string[] = [];
  private isWriting = false;

  constructor(options: FileTransportOptions) {
    this.minLevel = options.minLevel || "info";
    this.logDir = options.logDir;
    this.filename = options.filename || "dotbot";
    this.maxSize = options.maxSize || 10 * 1024 * 1024; // 10MB
    this.maxFiles = options.maxFiles || 5;
    this.jsonFormat = options.jsonFormat ?? true;
    this.currentPath = this.getLogPath();
    
    this.ensureLogDir();
    this.openStream();
  }

  private ensureLogDir(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  private getLogPath(): string {
    const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    return path.join(this.logDir, `${this.filename}-${date}.log`);
  }

  private openStream(): void {
    this.currentPath = this.getLogPath();
    
    // Get current file size if exists
    try {
      const stats = fs.statSync(this.currentPath);
      this.currentSize = stats.size;
    } catch {
      this.currentSize = 0;
    }

    this.writeStream = fs.createWriteStream(this.currentPath, { flags: "a" });
    
    this.writeStream.on("error", (err: Error) => {
      console.error("[FileTransport] Write error:", err);
    });
  }

  log(entry: LogEntry): void {
    const line = this.jsonFormat
      ? JSON.stringify(entry) + "\n"
      : this.formatPlainText(entry) + "\n";

    this.writeQueue.push(line);
    this.processQueue();
  }

  private formatPlainText(entry: LogEntry): string {
    const parts = [
      entry.timestamp,
      entry.level.toUpperCase().padEnd(5),
      `[${entry.component}]`,
      entry.message
    ];

    if (entry.correlationId) {
      parts.push(`cid=${entry.correlationId}`);
    }

    if (entry.data) {
      parts.push(JSON.stringify(entry.data));
    }

    if (entry.error) {
      parts.push(`ERROR: ${entry.error.name}: ${entry.error.message}`);
      if (entry.error.stack) {
        parts.push(entry.error.stack);
      }
    }

    return parts.join(" ");
  }

  private processQueue(): void {
    if (this.isWriting || this.writeQueue.length === 0 || !this.writeStream) {
      return;
    }

    this.isWriting = true;
    const line = this.writeQueue.shift()!;
    
    // Check if we need to rotate
    if (this.currentSize + line.length > this.maxSize) {
      this.rotate();
    }

    // Check if date changed (new day = new file)
    const expectedPath = this.getLogPath();
    if (expectedPath !== this.currentPath) {
      this.writeStream.end();
      this.openStream();
    }

    this.writeStream.write(line, (err: Error | null | undefined) => {
      if (!err) {
        this.currentSize += line.length;
      }
      this.isWriting = false;
      this.processQueue();
    });
  }

  private rotate(): void {
    if (this.writeStream) {
      this.writeStream.end();
    }

    // Rotate existing files
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const oldPath = `${this.currentPath}.${i}`;
      const newPath = `${this.currentPath}.${i + 1}`;
      if (fs.existsSync(oldPath)) {
        if (i === this.maxFiles - 1) {
          fs.unlinkSync(oldPath); // Delete oldest
        } else {
          fs.renameSync(oldPath, newPath);
        }
      }
    }

    // Rotate current file
    if (fs.existsSync(this.currentPath)) {
      fs.renameSync(this.currentPath, `${this.currentPath}.1`);
    }

    this.openStream();
  }

  async flush(): Promise<void> {
    return new Promise((resolve) => {
      if (this.writeStream) {
        // Process remaining queue
        const processRemaining = (): void => {
          if (this.writeQueue.length > 0) {
            setTimeout(processRemaining, 10);
          } else {
            this.writeStream?.once("drain", () => resolve());
            if (this.writeStream?.writableLength === 0) {
              resolve();
            }
          }
        };
        processRemaining();
      } else {
        resolve();
      }
    });
  }

  async close(): Promise<void> {
    await this.flush();
    return new Promise((resolve) => {
      if (this.writeStream) {
        this.writeStream.end(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
