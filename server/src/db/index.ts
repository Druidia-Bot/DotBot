/**
 * Database Manager
 * 
 * SQLite database for task management, sessions, and temporary state.
 */

import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";

// ============================================
// DATABASE SETUP
// ============================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  
  // Run schema
  const schemaPath = path.join(__dirname, "schema.sql");
  if (fs.existsSync(schemaPath)) {
    const schema = fs.readFileSync(schemaPath, "utf-8");
    db.exec(schema);
  } else {
    // Inline schema if file not found (for compiled builds)
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        thread_id TEXT,
        description TEXT NOT NULL,
        persona_id TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME,
        estimated_duration_ms INTEGER,
        timeout_at DATETIME,
        completed_at DATETIME,
        depends_on TEXT,
        checkpoint TEXT,
        attempt_count INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 3,
        result TEXT,
        error TEXT
      );
      
      CREATE TABLE IF NOT EXISTS task_assets (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        asset_type TEXT,
        original_filename TEXT,
        client_temp_path TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      
      CREATE TABLE IF NOT EXISTS task_timers (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        check_at DATETIME NOT NULL,
        check_type TEXT,
        executed INTEGER DEFAULT 0,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        device_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'active'
      );
      
      CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_task_timers_check_at ON task_timers(check_at) WHERE executed = 0;

      CREATE TABLE IF NOT EXISTS user_credits (
        user_id TEXT PRIMARY KEY,
        balance INTEGER NOT NULL DEFAULT 50,
        lifetime_earned INTEGER NOT NULL DEFAULT 50,
        lifetime_spent INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS credit_transactions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,
        reason TEXT NOT NULL,
        tool_id TEXT,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_credit_transactions_user ON credit_transactions(user_id);

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        hw_fingerprint TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        is_admin INTEGER DEFAULT 0,
        registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_auth_at DATETIME,
        last_ip TEXT,
        revoked_at DATETIME,
        revoke_reason TEXT
      );

      CREATE TABLE IF NOT EXISTS invite_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        created_by TEXT DEFAULT 'admin',
        max_uses INTEGER DEFAULT 1,
        used_count INTEGER DEFAULT 0,
        expires_at DATETIME NOT NULL,
        label TEXT,
        status TEXT DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS auth_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        device_id TEXT,
        ip TEXT,
        reason TEXT,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
      CREATE INDEX IF NOT EXISTS idx_invite_tokens_hash ON invite_tokens(token_hash);
      CREATE INDEX IF NOT EXISTS idx_invite_tokens_status ON invite_tokens(status);
      CREATE INDEX IF NOT EXISTS idx_auth_events_type ON auth_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_auth_events_ip ON auth_events(ip);
      CREATE INDEX IF NOT EXISTS idx_auth_events_created ON auth_events(created_at);

      CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        model TEXT NOT NULL,
        role TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        agent_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_token_usage_device ON token_usage(device_id);
      CREATE INDEX IF NOT EXISTS idx_token_usage_timestamp ON token_usage(timestamp);
      CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage(agent_id);
    `);
  }
  
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
