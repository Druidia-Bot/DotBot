/**
 * Database Migrations
 *
 * Sequential, numbered migrations that bring the database schema
 * from any prior version to the current version. Runs at startup
 * after the database file is opened.
 *
 * Rules:
 * - Migrations are append-only. Never edit a shipped migration.
 * - Each migration runs inside a transaction.
 * - Migration 0 is the baseline — it creates all tables that
 *   previously lived in schema.sql / inline CREATE TABLE blocks.
 * - To evolve the schema, add a new function to the `migrations` array.
 */

import type Database from "better-sqlite3";

// ============================================
// MIGRATION RUNNER
// ============================================

type Migration = (db: Database.Database) => void;

/**
 * Run all pending migrations against the open database.
 * Safe to call on every startup — already-applied migrations are skipped.
 */
export function runMigrations(db: Database.Database): void {
  // Ensure the version-tracking table exists (bootstrap)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const currentVersion = (
    db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as any
  )?.v ?? -1;

  if (currentVersion >= migrations.length - 1) {
    return; // fully up to date
  }

  console.log(
    `[DB] Schema at v${currentVersion}, target v${migrations.length - 1} — running ${migrations.length - 1 - currentVersion} migration(s)`,
  );

  const stamp = db.prepare(
    "INSERT INTO schema_version (version, applied_at) VALUES (?, datetime('now'))",
  );

  for (let i = currentVersion + 1; i < migrations.length; i++) {
    const txn = db.transaction(() => {
      migrations[i](db);
      stamp.run(i);
    });
    txn();
    console.log(`[DB] Applied migration ${i}`);
  }
}

// ============================================
// MIGRATIONS
// ============================================

const migrations: Migration[] = [
  // ── v0: Baseline ──────────────────────────────────────────────────
  // Creates every table that existed before the migration system.
  // All statements use IF NOT EXISTS so this is safe on both fresh
  // databases and databases that already have these tables.
  function v0_baseline(db) {
    db.exec(`
      -- Core task management
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

      -- Credits
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

      -- Auth
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

      -- Token usage tracking
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

      -- Deferred tasks (scheduler)
      CREATE TABLE IF NOT EXISTS deferred_tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        original_prompt TEXT NOT NULL,
        deferred_by TEXT NOT NULL,
        defer_reason TEXT NOT NULL,
        scheduled_for DATETIME NOT NULL,
        attempt_count INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 3,
        priority TEXT DEFAULT 'P2',
        status TEXT DEFAULT 'scheduled',
        context TEXT,
        thread_ids TEXT,
        result TEXT,
        error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Recurring tasks (scheduler)
      CREATE TABLE IF NOT EXISTS recurring_tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        device_id TEXT,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        persona_hint TEXT,
        schedule_type TEXT NOT NULL,
        schedule_time TEXT,
        schedule_day_of_week INTEGER,
        schedule_interval_minutes INTEGER,
        timezone TEXT DEFAULT 'UTC',
        priority TEXT DEFAULT 'P2',
        status TEXT DEFAULT 'active',
        last_run_at TEXT,
        next_run_at TEXT NOT NULL,
        last_result TEXT,
        last_error TEXT,
        consecutive_failures INTEGER DEFAULT 0,
        max_failures INTEGER DEFAULT 3,
        missed_prompt_sent_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_task_timers_check_at ON task_timers(check_at) WHERE executed = 0;
      CREATE INDEX IF NOT EXISTS idx_task_assets_task_id ON task_assets(task_id);
      CREATE INDEX IF NOT EXISTS idx_credit_transactions_user ON credit_transactions(user_id);
      CREATE INDEX IF NOT EXISTS idx_credit_transactions_created ON credit_transactions(created_at);
      CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
      CREATE INDEX IF NOT EXISTS idx_invite_tokens_hash ON invite_tokens(token_hash);
      CREATE INDEX IF NOT EXISTS idx_invite_tokens_status ON invite_tokens(status);
      CREATE INDEX IF NOT EXISTS idx_auth_events_type ON auth_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_auth_events_ip ON auth_events(ip);
      CREATE INDEX IF NOT EXISTS idx_auth_events_created ON auth_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_token_usage_device ON token_usage(device_id);
      CREATE INDEX IF NOT EXISTS idx_token_usage_timestamp ON token_usage(timestamp);
      CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage(agent_id);
      CREATE INDEX IF NOT EXISTS idx_deferred_scheduled ON deferred_tasks(scheduled_for) WHERE status = 'scheduled';
      CREATE INDEX IF NOT EXISTS idx_deferred_user ON deferred_tasks(user_id);
      CREATE INDEX IF NOT EXISTS idx_deferred_status ON deferred_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_recurring_next_run ON recurring_tasks(next_run_at) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_recurring_user ON recurring_tasks(user_id);
      CREATE INDEX IF NOT EXISTS idx_recurring_status ON recurring_tasks(status);
    `);
  },

  // ── v1: Schema reconciliation ──────────────────────────────────────
  // Inspects every table with PRAGMA table_info and adds any columns
  // that are missing. Handles databases created at any prior point in
  // the project's history where columns may have been added to the
  // CREATE TABLE but never ALTER TABLE'd onto existing DBs.
  function v1_reconcile_columns(db) {
    // Canonical column specs: [table, column, type + default]
    // Only columns that might be missing on older DBs need to be listed.
    // Columns present since the very first schema version can be omitted.
    const requiredColumns: [string, string, string][] = [
      // tasks
      ["tasks", "thread_id", "TEXT"],
      ["tasks", "persona_id", "TEXT"],
      ["tasks", "estimated_duration_ms", "INTEGER"],
      ["tasks", "timeout_at", "DATETIME"],
      ["tasks", "completed_at", "DATETIME"],
      ["tasks", "depends_on", "TEXT"],
      ["tasks", "checkpoint", "TEXT"],
      ["tasks", "attempt_count", "INTEGER DEFAULT 0"],
      ["tasks", "max_attempts", "INTEGER DEFAULT 3"],
      ["tasks", "result", "TEXT"],
      ["tasks", "error", "TEXT"],

      // task_assets
      ["task_assets", "asset_type", "TEXT"],
      ["task_assets", "original_filename", "TEXT"],
      ["task_assets", "client_temp_path", "TEXT"],
      ["task_assets", "expires_at", "DATETIME"],

      // task_timers
      ["task_timers", "check_type", "TEXT"],
      ["task_timers", "executed", "INTEGER DEFAULT 0"],

      // sessions
      ["sessions", "device_id", "TEXT"],
      ["sessions", "last_active_at", "DATETIME DEFAULT CURRENT_TIMESTAMP"],
      ["sessions", "status", "TEXT DEFAULT 'active'"],

      // user_credits
      ["user_credits", "lifetime_earned", "INTEGER NOT NULL DEFAULT 50"],
      ["user_credits", "lifetime_spent", "INTEGER NOT NULL DEFAULT 0"],
      ["user_credits", "updated_at", "DATETIME DEFAULT CURRENT_TIMESTAMP"],

      // credit_transactions
      ["credit_transactions", "tool_id", "TEXT"],
      ["credit_transactions", "metadata", "TEXT"],

      // devices
      ["devices", "is_admin", "INTEGER DEFAULT 0"],
      ["devices", "last_auth_at", "DATETIME"],
      ["devices", "last_ip", "TEXT"],
      ["devices", "revoked_at", "DATETIME"],
      ["devices", "revoke_reason", "TEXT"],

      // invite_tokens
      ["invite_tokens", "created_by", "TEXT DEFAULT 'admin'"],
      ["invite_tokens", "max_uses", "INTEGER DEFAULT 1"],
      ["invite_tokens", "used_count", "INTEGER DEFAULT 0"],
      ["invite_tokens", "label", "TEXT"],
      ["invite_tokens", "status", "TEXT DEFAULT 'active'"],

      // auth_events
      ["auth_events", "device_id", "TEXT"],
      ["auth_events", "ip", "TEXT"],
      ["auth_events", "reason", "TEXT"],
      ["auth_events", "metadata", "TEXT"],

      // token_usage
      ["token_usage", "agent_id", "TEXT"],

      // deferred_tasks
      ["deferred_tasks", "attempt_count", "INTEGER DEFAULT 0"],
      ["deferred_tasks", "max_attempts", "INTEGER DEFAULT 3"],
      ["deferred_tasks", "priority", "TEXT DEFAULT 'P2'"],
      ["deferred_tasks", "status", "TEXT DEFAULT 'scheduled'"],
      ["deferred_tasks", "context", "TEXT"],
      ["deferred_tasks", "thread_ids", "TEXT"],
      ["deferred_tasks", "result", "TEXT"],
      ["deferred_tasks", "error", "TEXT"],
      ["deferred_tasks", "updated_at", "DATETIME DEFAULT CURRENT_TIMESTAMP"],

      // recurring_tasks
      ["recurring_tasks", "device_id", "TEXT"],
      ["recurring_tasks", "persona_hint", "TEXT"],
      ["recurring_tasks", "schedule_time", "TEXT"],
      ["recurring_tasks", "schedule_day_of_week", "INTEGER"],
      ["recurring_tasks", "schedule_interval_minutes", "INTEGER"],
      ["recurring_tasks", "timezone", "TEXT DEFAULT 'UTC'"],
      ["recurring_tasks", "priority", "TEXT DEFAULT 'P2'"],
      ["recurring_tasks", "status", "TEXT DEFAULT 'active'"],
      ["recurring_tasks", "last_run_at", "TEXT"],
      ["recurring_tasks", "last_result", "TEXT"],
      ["recurring_tasks", "last_error", "TEXT"],
      ["recurring_tasks", "consecutive_failures", "INTEGER DEFAULT 0"],
      ["recurring_tasks", "max_failures", "INTEGER DEFAULT 3"],
      ["recurring_tasks", "missed_prompt_sent_at", "TEXT"],
      ["recurring_tasks", "updated_at", "TEXT DEFAULT CURRENT_TIMESTAMP"],
    ];

    // Cache table_info lookups
    const columnCache = new Map<string, Set<string>>();

    function getExistingColumns(table: string): Set<string> {
      let cols = columnCache.get(table);
      if (cols) return cols;

      // Check if table exists at all
      const tableExists = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
      ).get(table);
      if (!tableExists) {
        cols = new Set<string>();
      } else {
        const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
        cols = new Set(rows.map(r => r.name));
      }
      columnCache.set(table, cols);
      return cols;
    }

    let added = 0;
    for (const [table, column, typeDef] of requiredColumns) {
      const existing = getExistingColumns(table);
      if (!existing.has(column)) {
        db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${typeDef}`);
        added++;
        console.log(`[DB] v1: Added column ${table}.${column}`);
      }
    }

    if (added === 0) {
      console.log("[DB] v1: All columns present — no changes needed");
    } else {
      console.log(`[DB] v1: Added ${added} missing column(s)`);
    }
  },

  // ── v2, v3, ... ───────────────────────────────────────────────────
  // Future migrations go here.
];
