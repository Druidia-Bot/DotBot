/**
 * Database Manager
 * 
 * SQLite database for task management, sessions, and temporary state.
 */

import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { nanoid } from "nanoid";
import { runMigrations } from "./migrations.js";

// ============================================
// DATABASE SETUP
// ============================================

const DB_DIR = process.env.DB_DIR || path.join(os.homedir(), ".bot", "server-data");
const DB_PATH = path.join(DB_DIR, "dotbot.db");

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return db;
}

export function initDatabase(): Database.Database {
  // Ensure directory exists
  fs.mkdirSync(DB_DIR, { recursive: true });
  
  // Open database
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  
  // Run migrations (creates tables on fresh DB, evolves schema on existing DB)
  runMigrations(db);
  
  console.log(`[DB] Database initialized at ${DB_PATH}`);
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ============================================
// TASK TYPES
// ============================================

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "timeout" | "cancelled";

export interface Task {
  id: string;
  userId: string;
  sessionId: string;
  threadId?: string;
  description: string;
  personaId?: string;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  estimatedDurationMs?: number;
  timeoutAt?: string;
  completedAt?: string;
  dependsOn?: string[];
  checkpoint?: any;
  attemptCount: number;
  maxAttempts: number;
  result?: any;
  error?: string;
}

export interface TaskAsset {
  id: string;
  taskId: string;
  userId: string;
  assetType?: string;
  originalFilename?: string;
  clientTempPath?: string;
  createdAt: string;
  expiresAt?: string;
}

export interface TaskTimer {
  id: string;
  taskId: string;
  checkAt: string;
  checkType: "timeout" | "progress" | "retry";
  executed: boolean;
}

// ============================================
// TASK OPERATIONS
// ============================================

export function createTask(task: Omit<Task, "id" | "createdAt" | "attemptCount" | "status">): Task {
  const db = getDatabase();
  const id = `task_${nanoid(12)}`;
  const now = new Date().toISOString();
  
  const stmt = db.prepare(`
    INSERT INTO tasks (id, user_id, session_id, thread_id, description, persona_id, status, created_at, estimated_duration_ms, timeout_at, depends_on, checkpoint, max_attempts)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    id,
    task.userId,
    task.sessionId,
    task.threadId || null,
    task.description,
    task.personaId || null,
    now,
    task.estimatedDurationMs || null,
    task.timeoutAt || null,
    task.dependsOn ? JSON.stringify(task.dependsOn) : null,
    task.checkpoint ? JSON.stringify(task.checkpoint) : null,
    task.maxAttempts || 3
  );
  
  return getTask(id)!;
}

export function getTask(id: string): Task | null {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
  return row ? rowToTask(row) : null;
}

export function getTasksBySession(sessionId: string): Task[] {
  const db = getDatabase();
  const rows = db.prepare("SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at DESC").all(sessionId) as any[];
  return rows.map(rowToTask);
}

export function getTasksByUser(userId: string, status?: TaskStatus): Task[] {
  const db = getDatabase();
  let query = "SELECT * FROM tasks WHERE user_id = ?";
  const params: any[] = [userId];
  
  if (status) {
    query += " AND status = ?";
    params.push(status);
  }
  
  query += " ORDER BY created_at DESC";
  const rows = db.prepare(query).all(...params) as any[];
  return rows.map(rowToTask);
}

export function updateTaskStatus(id: string, status: TaskStatus, extras?: { result?: any; error?: string; checkpoint?: any }): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  
  let query = "UPDATE tasks SET status = ?";
  const params: any[] = [status];
  
  if (status === "running") {
    query += ", started_at = ?, attempt_count = attempt_count + 1";
    params.push(now);
  } else if (status === "completed" || status === "failed" || status === "timeout") {
    query += ", completed_at = ?";
    params.push(now);
  }
  
  if (extras?.result !== undefined) {
    query += ", result = ?";
    params.push(JSON.stringify(extras.result));
  }
  
  if (extras?.error !== undefined) {
    query += ", error = ?";
    params.push(extras.error);
  }
  
  if (extras?.checkpoint !== undefined) {
    query += ", checkpoint = ?";
    params.push(JSON.stringify(extras.checkpoint));
  }
  
  query += " WHERE id = ?";
  params.push(id);
  
  db.prepare(query).run(...params);
}

export function updateTaskCheckpoint(id: string, checkpoint: any): void {
  const db = getDatabase();
  db.prepare("UPDATE tasks SET checkpoint = ? WHERE id = ?").run(JSON.stringify(checkpoint), id);
}

// ============================================
// TIMER OPERATIONS
// ============================================

export function createTimer(taskId: string, checkAt: Date, checkType: "timeout" | "progress" | "retry"): TaskTimer {
  const db = getDatabase();
  const id = `timer_${nanoid(12)}`;
  
  db.prepare(`
    INSERT INTO task_timers (id, task_id, check_at, check_type)
    VALUES (?, ?, ?, ?)
  `).run(id, taskId, checkAt.toISOString(), checkType);
  
  return { id, taskId, checkAt: checkAt.toISOString(), checkType, executed: false };
}

export function getDueTimers(): TaskTimer[] {
  const db = getDatabase();
  const now = new Date().toISOString();
  const rows = db.prepare(`
    SELECT * FROM task_timers 
    WHERE executed = 0 AND check_at <= ? 
    ORDER BY check_at
  `).all(now) as any[];
  
  return rows.map(row => ({
    id: row.id,
    taskId: row.task_id,
    checkAt: row.check_at,
    checkType: row.check_type,
    executed: !!row.executed
  }));
}

export function markTimerExecuted(id: string): void {
  const db = getDatabase();
  db.prepare("UPDATE task_timers SET executed = 1 WHERE id = ?").run(id);
}

// ============================================
// ASSET OPERATIONS
// ============================================

export function createAsset(asset: Omit<TaskAsset, "id" | "createdAt">): TaskAsset {
  const db = getDatabase();
  const id = `asset_${nanoid(12)}`;
  const now = new Date().toISOString();
  
  db.prepare(`
    INSERT INTO task_assets (id, task_id, user_id, asset_type, original_filename, client_temp_path, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    asset.taskId,
    asset.userId,
    asset.assetType || null,
    asset.originalFilename || null,
    asset.clientTempPath || null,
    now,
    asset.expiresAt || null
  );
  
  return { ...asset, id, createdAt: now };
}

export function getAssetsByTask(taskId: string): TaskAsset[] {
  const db = getDatabase();
  const rows = db.prepare("SELECT * FROM task_assets WHERE task_id = ?").all(taskId) as any[];
  return rows.map(row => ({
    id: row.id,
    taskId: row.task_id,
    userId: row.user_id,
    assetType: row.asset_type,
    originalFilename: row.original_filename,
    clientTempPath: row.client_temp_path,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  }));
}

export function deleteAssetsBySession(sessionId: string): number {
  const db = getDatabase();
  const result = db.prepare(`
    DELETE FROM task_assets 
    WHERE task_id IN (SELECT id FROM tasks WHERE session_id = ?)
  `).run(sessionId);
  return result.changes;
}

// ============================================
// HELPERS
// ============================================

function rowToTask(row: any): Task {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    threadId: row.thread_id || undefined,
    description: row.description,
    personaId: row.persona_id || undefined,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at || undefined,
    estimatedDurationMs: row.estimated_duration_ms || undefined,
    timeoutAt: row.timeout_at || undefined,
    completedAt: row.completed_at || undefined,
    dependsOn: row.depends_on ? JSON.parse(row.depends_on) : undefined,
    checkpoint: row.checkpoint ? JSON.parse(row.checkpoint) : undefined,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    result: row.result ? JSON.parse(row.result) : undefined,
    error: row.error || undefined
  };
}
