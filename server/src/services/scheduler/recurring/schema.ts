/**
 * Recurring Tasks — Schema
 *
 * SQLite table creation for the recurring_tasks table.
 */

import * as db from "../../../db/index.js";
import { createComponentLogger } from "#logging.js";

const log = createComponentLogger("recurring.schema");

export function ensureRecurringSchema(): void {
  try {
    const database = db.getDatabase();
    database.exec(`
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
      CREATE INDEX IF NOT EXISTS idx_recurring_next_run
        ON recurring_tasks(next_run_at) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_recurring_user
        ON recurring_tasks(user_id);
      CREATE INDEX IF NOT EXISTS idx_recurring_status
        ON recurring_tasks(status);
    `);
  } catch (error) {
    log.error("Failed to ensure recurring schema", { error });
  }
}
