/**
 * Deferred Tasks — Schema
 *
 * SQLite table creation for the deferred_tasks table.
 */

import * as db from "../../../db/index.js";
import { createComponentLogger } from "#logging.js";

const log = createComponentLogger("scheduler.schema");

export function ensureDeferredSchema(): void {
  try {
    const database = db.getDatabase();
    database.exec(`
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
      CREATE INDEX IF NOT EXISTS idx_deferred_scheduled 
        ON deferred_tasks(scheduled_for) WHERE status = 'scheduled';
      CREATE INDEX IF NOT EXISTS idx_deferred_user 
        ON deferred_tasks(user_id);
      CREATE INDEX IF NOT EXISTS idx_deferred_status 
        ON deferred_tasks(status);
    `);
  } catch (error) {
    log.error("Failed to ensure scheduler schema", { error });
  }
}
