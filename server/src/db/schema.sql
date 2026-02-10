-- DotBot Task Management Schema

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  thread_id TEXT,
  
  -- Task definition
  description TEXT NOT NULL,
  persona_id TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'timeout', 'cancelled')),
  
  -- Timing
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  estimated_duration_ms INTEGER,
  timeout_at DATETIME,
  completed_at DATETIME,
  
  -- Dependencies
  depends_on TEXT,  -- JSON array of task IDs
  
  -- State & Recovery
  checkpoint TEXT,  -- JSON: last known good state
  attempt_count INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  
  -- Result
  result TEXT,  -- JSON: output from persona
  error TEXT
);

-- Task assets (references to client-side temp files)
CREATE TABLE IF NOT EXISTS task_assets (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  
  -- Asset info
  asset_type TEXT,
  original_filename TEXT,
  client_temp_path TEXT,
  
  -- Lifecycle
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME,
  
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- Scheduled checks (cron-like timers)
CREATE TABLE IF NOT EXISTS task_timers (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  check_at DATETIME NOT NULL,
  check_type TEXT CHECK (check_type IN ('timeout', 'progress', 'retry')),
  executed INTEGER DEFAULT 0,
  
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- Sessions table (track active user sessions)
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'idle', 'closed'))
);

-- User credits (premium tool access)
CREATE TABLE IF NOT EXISTS user_credits (
  user_id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 50,
  lifetime_earned INTEGER NOT NULL DEFAULT 50,
  lifetime_spent INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Credit transaction log
CREATE TABLE IF NOT EXISTS credit_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,  -- positive = credit, negative = debit
  balance_after INTEGER NOT NULL,
  reason TEXT NOT NULL,
  tool_id TEXT,  -- which premium tool was used (null for grants)
  metadata TEXT,  -- JSON: extra context (query, api params, etc.)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Registered devices
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  hw_fingerprint TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  is_admin INTEGER DEFAULT 0,
  registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_auth_at DATETIME,
  last_ip TEXT,
  revoked_at DATETIME,
  revoke_reason TEXT
);

-- Invite tokens
CREATE TABLE IF NOT EXISTS invite_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT DEFAULT 'admin',
  max_uses INTEGER DEFAULT 1,
  used_count INTEGER DEFAULT 0,
  expires_at DATETIME NOT NULL,
  label TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'revoked', 'expired')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Auth events (audit trail + rate limiting foundation)
CREATE TABLE IF NOT EXISTS auth_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN ('auth_success', 'auth_failure', 'register', 'revoke', 'fingerprint_mismatch')),
  device_id TEXT,
  ip TEXT,
  reason TEXT,
  metadata TEXT,  -- JSON: extra context
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for common queries
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
