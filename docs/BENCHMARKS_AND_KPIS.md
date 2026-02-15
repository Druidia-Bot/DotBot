# DotBot — Benchmarks & Key Performance Indicators

> **Purpose:** Define measurable success criteria and KPIs for monitoring DotBot's health, performance, and value delivery. Review these regularly to determine if the program is on track.
>
> **Last Updated:** 2026-02-12

---

## How to Use This Document

Each KPI section includes:
- **What to measure** — the metric itself
- **Where to find it** — the file, log, or system that produces the data
- **Target** — what "good" looks like
- **Red flag** — when to investigate

Priority levels: **P0** (check daily), **P1** (check weekly), **P2** (check monthly)

---

## 1. Pipeline Reliability (P0)

These KPIs tell you whether DotBot is actually completing tasks successfully — the single most important signal.

### 1.1 Task Completion Rate

| Metric | Source | Target | Red Flag |
|--------|--------|--------|----------|
| % of pipeline runs that produce a substantive response (not error/abort) | `token_usage` SQLite table + judge verdicts in logs | ≥ 90% | < 75% |
| Judge verdict distribution: `pass` vs `cleaned` vs `rerun` vs `abort` | Enhanced Judge output (`server/src/agents/judge.ts`) | ≥ 80% `pass`, < 5% `abort` | `abort` > 10% |
| Escalation rate (agent → architect) | Tool loop stuck detection (`tool-loop.ts`) | < 10% of tasks | > 20% |
| Supervisor intervention rate | `AgentSupervisor` stuck detection (`supervisor.ts`) | < 5% of tasks | > 15% |

### 1.2 Tool Execution Health

| Metric | Source | Target | Red Flag |
|--------|--------|--------|----------|
| Tool call success rate (overall) | Tool call logs in `~/.bot/agent-workspaces/*/logs/tool-calls.jsonl` | ≥ 95% | < 85% |
| Consecutive same-tool calls (stuck indicator) | Tool loop stuck counter in `tool-loop.ts` (warns at 3, escalates at 5) | < 1% of tool loops hit 5 | > 5% hit 5 |
| Tool manifest size vs tools actually used | Core registry (174 tools) vs tool call logs | ≥ 40 unique tools used per week | < 20 unique tools used |
| Parse failures (LLM returns invalid tool call JSON) | `sanitizeMessages` invocations in `tool-loop.ts` | < 2% of LLM calls | > 5% |

### 1.3 Pipeline Stage Health

| Stage | Metric | Target | Red Flag |
|-------|--------|--------|----------|
| Short Path | % of messages handled without full pipeline | 5-15% (trivial messages) | > 30% (over-triggering) or 0% (broken) |
| Receptionist | Classification confidence score (from `ReceptionistDecision`) | Mean ≥ 0.8 | Mean < 0.6 |
| Persona Writer | Tool selection fallback rate (zero matching tool IDs → full manifest) | < 5% | > 15% |
| Follow-up Routing | % of follow-ups correctly matched to existing agents | ≥ 80% of follow-ups | < 50% |
| Workspace Continuation | Reuse rate when follow-up matches completed agent | Track count, trend upward | N/A (new feature) |

---

## 2. Latency & Responsiveness (P0)

Speed matters. DotBot should feel responsive even when running multi-step pipelines.

### 2.1 End-to-End Response Time

| Metric | Source | Target | Red Flag |
|--------|--------|--------|----------|
| Short path response time | Timestamps in pipeline logs | < 2 seconds | > 5 seconds |
| Simple task (single agent, ≤3 tool calls) | Pipeline duration | < 15 seconds | > 30 seconds |
| Complex task (multi-agent or research) | Pipeline duration | < 2 minutes | > 5 minutes |
| Heartbeat evaluation time | `HeartbeatResult.durationMs` | < 10 seconds | > 30 seconds (timeout) |

### 2.2 LLM Call Latency

| Model Role | Primary Provider | Target p50 | Target p95 | Red Flag |
|------------|-----------------|------------|------------|----------|
| **intake** (receptionist, judge, reflector) | xAI Grok 4.1 Fast | < 2s | < 5s | p50 > 5s |
| **workhorse** (tool loops) | DeepSeek V3.2 | < 5s | < 15s | p50 > 10s |
| **architect** (escalation) | Claude Opus 4.6 | < 10s | < 30s | p50 > 20s |
| **deep_context** (large docs) | Gemini 3 Pro | < 10s | < 45s | p50 > 30s |

### 2.3 WebSocket Latency

| Metric | Source | Target | Red Flag |
|--------|--------|--------|----------|
| Agent ↔ Server round-trip (tool execution) | Timestamp delta on `tool_execute` → `tool_result` | < 500ms for local tools | > 2s consistently |
| Credential proxy round-trip | `credential_proxy_request` → `credential_proxy_response` | < 2s | > 5s |
| Heartbeat WS round-trip | `heartbeat_request` → `heartbeat_response` | < 30s (timeout) | Timeouts > 10% |

---

## 3. Cost Efficiency (P1)

LLM API calls are the primary operating cost. Track these to avoid runaway spending.

### 3.1 Token Usage

| Metric | Source | Target | Red Flag |
|--------|--------|--------|----------|
| Total tokens per task (input + output) | `token_usage` SQLite table (`server/src/agents/token-tracker.ts`) | Track trend; median < 25K tokens/task | Median > 50K tokens/task |
| Tokens by role (receptionist/agent/judge/supervisor/reflector/architect) | `token_usage` table `role` column | Agent (workhorse) = 70-80% of total | Architect > 20% of total (over-escalation) |
| Intake model tokens (routing overhead) | `token_usage` where role = receptionist/judge/reflector | < 15% of total tokens | > 25% (pipeline overhead too high) |
| Wasted tokens (rerun verdicts, aborted tasks) | Judge `rerun` + `abort` verdicts × tokens consumed | < 10% of total | > 20% |

### 3.2 Model Role Distribution

| Metric | Source | Target | Red Flag |
|--------|--------|--------|----------|
| % of LLM calls using workhorse | `token_usage` table | ≥ 80% | < 60% (too many expensive calls) |
| % of LLM calls using architect | `token_usage` table | < 5% | > 15% |
| Fallback chain activations | `getRuntimeFallbacks()` invocations in `resilient-client.ts` | < 5% of calls | > 20% (primary providers unreliable) |

### 3.3 Cost per Task (Estimated)

| Task Type | Target Cost | Red Flag |
|-----------|-------------|----------|
| Simple (greeting, quick answer) | < $0.001 | > $0.01 |
| Standard (single agent, research) | < $0.02 | > $0.10 |
| Complex (multi-agent, architect escalation) | < $0.15 | > $0.50 |
| Heartbeat check (every 5 min) | < $0.001 | > $0.005 |

---

## 4. Memory & Knowledge Effectiveness (P1)

Memory is DotBot's differentiator. If it's not learning and retaining, it's just another chatbot.

### 4.1 Memory Utilization

| Metric | Source | Target | Red Flag |
|--------|--------|--------|----------|
| Mental models in hot memory (`~/.bot/memory/models/`) | `ls ~/.bot/memory/models/ \| wc -l` | 20-100 models (grows over time) | 0 (never learning) or > 200 (never pruning) |
| Mental models in deep memory (`~/.bot/memory/deep/`) | `ls ~/.bot/memory/deep/ \| wc -l` | Present after weeks of use | Empty after months |
| L0 index size | `~/.bot/memory/index.json` | Grows steadily | Static for weeks |
| Model skeletons injected per task | `buildMemoryContextSection()` in `execution.ts` (top 5 with score ≥ 4) | 2-5 per task | 0 consistently (scoring broken) |
| Deep memory promotions | `searchAndPromote()` calls in `store-models.ts` | Occasional (proves retrieval works) | Never (deep memory is a black hole) |

### 4.2 Knowledge Base Health

| Metric | Source | Target | Red Flag |
|--------|--------|--------|----------|
| General knowledge docs (`~/.bot/knowledge/`) | File count | Grows over time | Static after initial bootstrap |
| Persona knowledge docs (`~/.bot/personas/*/knowledge/`) | File count per persona | ≥ 1 per active persona | 0 for personas that should have knowledge |
| Knowledge retrieval hit rate | `calculateRelevance()` results in `discovery-handlers.ts` (threshold ≥ 0.1) | ≥ 50% of queries return results | < 20% |
| Knowledge injection into prompts | `injectRelevantKnowledge()` in `execution.ts` (maxCharacters: 4000) | Active on most tasks | Never injected |

### 4.3 Sleep Cycle & Consolidation

| Metric | Source | Target | Red Flag |
|--------|--------|--------|----------|
| Sleep cycle completion rate | `sleep-cycle.ts` — runs every 30 min idle | ≥ 1/day when agent is active | 0 for days (starvation bug) |
| Thread condensation rate | Threads condensed per sleep cycle | ≥ 1 thread with new activity | 0 (condenser broken or no threads) |
| Open loop resolution rate | Loops resolved / loops total per sleep cycle | Track trend upward | All loops stay unresolved |
| Loop resolution notifications sent | `setSleepCycleLoopCallback` firings | Occasional | Never (callback not wired) |

---

## 5. Security & Compliance (P0)

Security is architectural — these should be pass/fail, not gradual metrics.

### 5.1 Credential Security (Pass/Fail)

| Check | Method | Pass | Fail |
|-------|--------|------|------|
| API keys never in LLM context | Audit tool call logs + LLM messages | No plaintext keys found | Any key in any message |
| Credential proxy SSRF protection | `validateProxyUrl()` test suite in `proxy.test.ts` | All 14 tests pass | Any SSRF bypass |
| Domain-scoped encryption working | `crypto.test.ts` domain mismatch tests | 6/6 domain tests pass | Any domain bypass |
| `credential_resolve` allowlist enforced | Only `DISCORD_BOT_TOKEN` resolvable | Hardcoded allowlist unchanged | New credentials added without review |
| Vault file on disk | `~/.bot/vault.json` | Only `srv:` prefixed blobs | Any plaintext values |

### 5.2 Authentication & Authorization

| Metric | Source | Target | Red Flag |
|--------|--------|--------|----------|
| Failed auth attempts (WS) | `getRecentFailures()` rate limiter in `server.ts` | < 3/15min per IP | Sustained brute force attempts |
| Invite token consumption rate | `invite_tokens` SQLite table | Matches admin-generated count | Tokens consumed without admin knowledge |
| Device registration anomalies | `devices` + `auth_events` SQLite tables | Only expected devices | Unknown device registrations |
| Discord Layer 1 rejections | Gateway adapter authorized user check | 0 (only authorized user sends messages) | High volume (bot token may be compromised) |

### 5.3 Security Audit Status

| Finding Level | Total Found (Feb 12 Audit) | Target Resolved | Red Flag |
|---------------|---------------------------|-----------------|----------|
| HIGH | 4 (SSRF, shell safety, device-session) | 100% resolved | Any HIGH unresolved |
| MEDIUM | 8 (env blocklist, CORS, XSS, etc.) | ≥ 75% resolved | < 50% resolved |
| LOW | 7 | Track, address opportunistically | N/A |

---

## 6. Reliability & Uptime (P0)

### 6.1 Agent Connectivity

| Metric | Source | Target | Red Flag |
|--------|--------|--------|----------|
| Heartbeat success rate | `HeartbeatResult.status` in `heartbeat-log.jsonl` | ≥ 95% `ok` + `alert` (not `error`) | `error` > 20% |
| Consecutive heartbeat failures | `consecutiveFailures` in heartbeat config | 0 (resets on success) | ≥ 3 (triggers backoff) |
| WS reconnect events per day | Exponential backoff counter in local agent | < 5 | > 20 (unstable connection) |
| WS reconnect max attempts before exit | 50 max, then `exit(42)` for launcher restart | Never hits 50 | Hits 50 (server down or network issue) |

### 6.2 Periodic System Health

| System | Interval | Health Check | Red Flag |
|--------|----------|--------------|----------|
| Heartbeat | 5 min (idle) | Produces `HEARTBEAT_OK` or actionable alert | Silent for > 30 min idle |
| Reminder checker | 15s | Fires due reminders within 15s of scheduled time | Reminders firing late or not at all |
| Scheduled task runner | 60s | Due tasks executed, missed tasks prompt user | Tasks silently missed (starvation bug) |
| Sleep cycle | 30 min (idle) | Completes thread condensation | Starved by other periodic tasks |
| Workspace cleanup | 10 min | Stale workspaces cleaned after 24h | Disk usage growing unbounded |

### 6.3 Disk Usage

| Location | Expected Size | Red Flag |
|----------|--------------|----------|
| `~/.bot/memory/` | 1-50 MB (grows with use) | > 500 MB (runaway models) |
| `~/.bot/agent-workspaces/` | 0-100 MB (transient, 24h cleanup) | > 1 GB (cleanup broken) |
| `~/.bot/vault.json` | < 10 KB | > 1 MB (unusual) |
| `~/.bot/reminders.json` | < 100 KB | > 10 MB (auto-cleanup broken) |
| `~/.bot/scheduled-tasks.json` | < 100 KB | > 10 MB |
| `~/.bot/heartbeat-log.jsonl` | < 5 MB (max 500 entries) | > 50 MB (rotation broken) |
| Server SQLite `dotbot.db` | 1-100 MB | > 1 GB (token_usage table unbounded) |

---

## 7. User Experience & Engagement (P1)

### 7.1 Interaction Quality

| Metric | Source | Target | Red Flag |
|--------|--------|--------|----------|
| Correction follow-ups (user re-asks differently) | Receptionist `CORRECTION` classification | < 15% of conversations | > 30% |
| Continuation follow-ups (user builds on response) | Receptionist `CONTINUATION` classification | Trend upward (user trusts output) | Declining over time |
| Direct response rate (receptionist handles without pipeline) | `directResponse` in `ReceptionistDecision` | 10-20% (quick answers) | > 40% (over-simplifying) |
| Average tool calls per task | Tool call logs | 3-8 for standard tasks | > 20 (thrashing) or 0 (tools not used) |

### 7.2 Discord Channel Activity

| Metric | Source | Target | Red Flag |
|--------|--------|--------|----------|
| Messages in #conversation per day | Discord channel history | ≥ 5 (active usage) | 0 for days (user disengaged or adapter broken) |
| Messages in #updates per day | Discord channel history | ≥ 3 (system active) | 0 (notifications broken) |
| Typing indicator responsiveness | `startTypingLoop()` in adapter | Fires within 1s of message receipt | Noticeable delay or missing |
| Long message splits (>2000 chars) | `splitMessage()` in adapter | Clean splits at newlines/spaces | Garbled or truncated output |

### 7.3 Persona & Skill Adoption

| Metric | Source | Target | Red Flag |
|--------|--------|--------|----------|
| Custom personas created | `~/.bot/personas/` directory count | ≥ 1 after first week | 0 after months (feature undiscoverable) |
| Custom skills created (user + reflector) | `~/.bot/skills/` directory count | Grows over time; reflector creates ≤ 5/day | 0 (reflector broken or quality gates too strict) |
| Skill match rate | `scoreModelEntry()` in `store-skills.ts` (threshold ≥ 3) | ≥ 20% of tasks match a skill | < 5% (skills too niche) |
| Custom tools created (tool maker) | `~/.bot/tools/custom/` file count | ≥ 1 after first month | 0 (tool maker persona not routing) |
| Learned tool usage rate | Tool calls to custom tools vs core tools | Any usage of custom tools | Custom tools exist but never called |

---

## 8. Self-Improvement Metrics (P2)

DotBot is designed to improve itself. These metrics track whether that's actually happening.

### 8.1 Reflector Output

| Metric | Source | Target | Red Flag |
|--------|--------|--------|----------|
| Reflector runs per day | Reflector invocations (async after each agent) | Matches task count | 0 (reflector not firing) |
| Skills created by reflector per week | `MAX_SKILLS_PER_DAY = 5` cap in `reflector.ts` | 1-5/week | 0/week (quality gates too strict) or 35/week (too permissive) |
| Skill quality (passes vague step rejection) | Reflector quality gates | ≥ 80% of candidates pass | < 50% (reflector generating low-quality skills) |

### 8.2 Tool Maker Activity

| Metric | Source | Target | Red Flag |
|--------|--------|--------|----------|
| API tools created | `~/.bot/tools/custom/*.json` with `apiSpec` | Track growth | N/A (depends on user needs) |
| Script tools created | `~/.bot/tools/scripts/*` | Track growth | N/A |
| Tool reusability gate pass rate | Tool-maker persona 5-point checklist | ≥ 80% of created tools used again | Tools created but never reused |

### 8.3 Memory Evolution

| Metric | Source | Target | Red Flag |
|--------|--------|--------|----------|
| New mental models per week | `~/.bot/memory/models/` creation dates | 2-10/week during active use | 0 (updater/condenser broken) |
| Belief updates per model per month | Model `.beliefs` array changes | Active models update regularly | Static for weeks (updater not working) |
| Open loops created and resolved | Model `.openLoops` arrays | Loops created AND resolved | Only created, never resolved |
| Thread archive growth | `~/.bot/memory/threads/archive/` | Grows as conversations happen | Never archived (threads accumulating) |

---

## 9. Scalability & Multi-Tenancy (P2)

Relevant when serving multiple users or preparing for SaaS deployment.

### 9.1 Server Capacity

| Metric | Source | Target | Red Flag |
|--------|--------|--------|----------|
| Concurrent WebSocket connections | `devices` table active count | Track capacity | > 50 with degraded performance |
| Concurrent pipeline executions | Active `executeV2Pipeline()` calls | Track; sequential per user | Cross-user interference |
| SQLite write contention | WAL mode + journal size | Transparent to users | Lock timeouts in logs |
| Token usage table growth rate | `token_usage` row count | Plan compaction at > 1M rows | Table > 100MB |

### 9.2 Onboarding Funnel

| Metric | Source | Target | Red Flag |
|--------|--------|--------|----------|
| Invite tokens generated | `invite_tokens` SQLite table | Matches planned user growth | Tokens unused (friction too high) |
| Install completion rate | Tokens consumed / tokens generated | ≥ 80% | < 50% (install failing) |
| Time from invite to first message | Token creation → first `prompt` WS message | < 1 hour | > 24 hours |
| Discord setup completion rate | `discord.setup_channels` success in tool logs | ≥ 90% of attempts | < 60% (setup skill broken) |

---

## 10. Upcoming Feature Readiness (P2)

Track readiness signals for planned features from `docs/upcoming-features/`.

### 10.1 Outcome-Based Learning Readiness

| Signal | Current State | Ready When |
|--------|---------------|------------|
| Outcome records accumulating | Not implemented | `~/.bot/outcomes/index.jsonl` has 100+ records |
| Preference pairs for training | Not implemented | 500+ pairs accumulated |
| Composite score distribution | Not implemented | Mean score trending positive over 4 weeks |
| Fewer corrections over time | Can measure via receptionist `CORRECTION` rate | CORRECTION rate decreases month-over-month |

### 10.2 Cross-Platform Readiness

| Signal | Current State | Ready When |
|--------|---------------|------------|
| Windows-specific code isolated | Mixed throughout `tool-executor.ts` | All in `local-agent/src/platform/` module |
| Shell abstraction layer | `shell.powershell` hardcoded | Platform-adaptive shell selection |
| Linux CI tests passing | Not tested | Agent starts, connects, and executes tools on Linux |

### 10.3 Fluid UI Readiness

| Signal | Current State | Ready When |
|--------|---------------|------------|
| Component spec format defined | Spec document exists | JSON schema validated + parseable |
| Primitive library built | Not implemented | ≥ 10 primitives rendering in client |
| Rules engine mapping fields to primitives | Not implemented | 90% of field types auto-mapped |

### 10.4 Local Personas & Councils V2 Readiness

| Signal | Current State | Ready When |
|--------|---------------|------------|
| Persona loader for `~/.bot/personas/` | V1 bootstrap exists | V2 `local-loader.ts` loading from disk |
| Direct mode execution path | Not implemented | Shortcut path tested end-to-end |
| Council orchestrator | Not implemented | Multi-round discussion producing merged output |

---

## Monitoring Checklist

### Daily (P0)
- [ ] Check pipeline completion rate (judge verdicts in logs)
- [ ] Check heartbeat success rate (`heartbeat-log.jsonl`)
- [ ] Check WS connection stability (reconnect count)
- [ ] Scan for security anomalies (failed auth attempts, unknown devices)

### Weekly (P1)
- [ ] Review token usage trends (`token_usage` table)
- [ ] Review model role distribution (workhorse vs architect usage)
- [ ] Check memory growth (mental models, knowledge docs)
- [ ] Review Discord channel activity
- [ ] Check skill creation/usage rates
- [ ] Review correction rate trend

### Monthly (P2)
- [ ] Review disk usage across `~/.bot/`
- [ ] Audit security findings resolution status
- [ ] Review self-improvement metrics (reflector, tool maker)
- [ ] Assess upcoming feature readiness signals
- [ ] Review onboarding funnel (if multi-tenant)
- [ ] Run `npx tsc --noEmit` and `npx vitest run` in both packages — ensure zero errors

---

## Building Instrumentation

Most of these KPIs can be measured today from existing data sources:

| Data Source | Already Exists | Measures |
|-------------|---------------|----------|
| `token_usage` SQLite table | ✅ Yes | Token costs, model role distribution, per-task cost |
| `heartbeat-log.jsonl` | ✅ Yes | Agent uptime, heartbeat health |
| `tool-calls.jsonl` (per workspace) | ✅ Yes | Tool success rates, tool diversity, stuck detection |
| `~/.bot/memory/` filesystem | ✅ Yes | Memory growth, model counts, knowledge docs |
| `~/.bot/agent-workspaces/` | ✅ Yes | Workspace cleanup, disk usage |
| Judge verdict logs | ✅ Yes (console) | Pipeline completion quality |
| Receptionist classification | ✅ Yes (console) | Correction rate, classification confidence |
| `auth_events` SQLite table | ✅ Yes | Security events, device registrations |
| Discord channel metrics | ✅ Yes (Discord API) | User engagement |

**Not yet instrumented (future work):**
- Centralized KPI dashboard (aggregate the above into a single view)
- Automated alerting on red flag thresholds
- Outcome-based learning signals (per upcoming feature spec)
- Historical trend storage for week-over-week comparisons

---

## HOW TO MEASURE: Practical Implementation Guide

### Prerequisites

**Database Access:**
```powershell
# Server SQLite database location
$DB_PATH = "$env:USERPROFILE\.bot\server-data\dotbot.db"

# Install sqlite3 if needed (Windows)
# Download from https://www.sqlite.org/download.html
# Or use: choco install sqlite
```

**Log File Locations:**
```powershell
$HEARTBEAT_LOG = "$env:USERPROFILE\.bot\heartbeat-log.jsonl"
$MEMORY_DIR = "$env:USERPROFILE\.bot\memory"
$WORKSPACES_DIR = "$env:USERPROFILE\.bot\agent-workspaces"
$VAULT_FILE = "$env:USERPROFILE\.bot\vault.json"
```

---

### 1. Pipeline Reliability Queries

#### 1.1 Task Completion Rate

**SQL Query - Token Usage by Outcome:**
```sql
-- Last 7 days task completion statistics
SELECT
    DATE(created_at) as date,
    COUNT(*) as total_tasks,
    SUM(CASE WHEN role = 'judge' THEN 1 ELSE 0 END) as judged_tasks,
    ROUND(AVG(input_tokens + output_tokens), 0) as avg_tokens_per_task
FROM token_usage
WHERE created_at >= datetime('now', '-7 days')
GROUP BY DATE(created_at)
ORDER BY date DESC;
```

**Judge Verdict Distribution:**
```powershell
# Parse server logs for judge verdicts (last 24h)
Get-Content "$env:USERPROFILE\.bot\server-data\logs\server-*.log" -Tail 10000 |
    Select-String "Judge verdict:" |
    Group-Object -Property { ($_ -split 'verdict:')[1].Trim().Split()[0] } |
    Select-Object Name, Count |
    Sort-Object Count -Descending
```

#### 1.2 Tool Execution Health

**Tool Success Rate Aggregation:**
```powershell
# Aggregate tool call success across all workspaces
$toolStats = Get-ChildItem "$env:USERPROFILE\.bot\agent-workspaces\*\logs\tool-calls.jsonl" -ErrorAction SilentlyContinue |
    Get-Content |
    ForEach-Object { $_ | ConvertFrom-Json } |
    Group-Object -Property success |
    Select-Object Name, Count

$successRate = ($toolStats | Where-Object Name -eq 'true').Count / ($toolStats.Count -as [double]) * 100
Write-Host "Tool Success Rate: $($successRate.ToString('0.00'))%"
```

**Tool Diversity Analysis:**
```sql
-- Unique tools used in last 7 days
SELECT
    COUNT(DISTINCT tool_name) as unique_tools_used,
    COUNT(*) as total_tool_calls,
    ROUND(COUNT(*) * 1.0 / COUNT(DISTINCT tool_name), 1) as avg_calls_per_tool
FROM (
    -- Note: tool call tracking not in SQLite yet, extract from JSONL files
    -- This is a placeholder for when tool_calls table is added
    SELECT 'placeholder' as tool_name
);
```

**PowerShell Alternative for Tool Diversity:**
```powershell
# Count unique tools used in last 7 days
$cutoffDate = (Get-Date).AddDays(-7)
Get-ChildItem "$env:USERPROFILE\.bot\agent-workspaces\*\logs\tool-calls.jsonl" -ErrorAction SilentlyContinue |
    Where-Object LastWriteTime -gt $cutoffDate |
    Get-Content |
    ForEach-Object { ($_ | ConvertFrom-Json).toolName } |
    Sort-Object -Unique |
    Measure-Object |
    Select-Object -ExpandProperty Count
```

---

### 2. Latency & Responsiveness Queries

#### 2.1 LLM Call Latency Analysis

**Token Usage with Timestamps:**
```sql
-- Average LLM response time by role (last 24 hours)
SELECT
    role,
    COUNT(*) as call_count,
    ROUND(AVG(CAST(strftime('%s', updated_at) - strftime('%s', created_at) AS REAL)), 2) as avg_duration_sec,
    MAX(CAST(strftime('%s', updated_at) - strftime('%s', created_at) AS REAL)) as max_duration_sec
FROM token_usage
WHERE created_at >= datetime('now', '-1 day')
GROUP BY role
ORDER BY avg_duration_sec DESC;
```

**Note:** This assumes `updated_at` column exists. If not, you'll need to add duration tracking to `token-tracker.ts`.

#### 2.2 Heartbeat Health Analysis

**Parse Heartbeat Log:**
```powershell
# Heartbeat success rate last 24 hours
$heartbeats = Get-Content $HEARTBEAT_LOG -Tail 500 |
    ForEach-Object { $_ | ConvertFrom-Json } |
    Where-Object { [DateTime]$_.timestamp -gt (Get-Date).AddDays(-1) }

$statusCounts = $heartbeats | Group-Object status
$successRate = (($statusCounts | Where-Object Name -in @('ok','alert')).Count -as [double]) / $heartbeats.Count * 100

Write-Host "Heartbeat Success Rate: $($successRate.ToString('0.00'))%"
Write-Host "Status Breakdown:"
$statusCounts | Format-Table Name, Count
```

---

### 3. Cost Efficiency Queries

#### 3.1 Token Usage by Role

```sql
-- Token consumption by role (last 30 days)
SELECT
    role,
    COUNT(*) as calls,
    SUM(input_tokens) as total_input,
    SUM(output_tokens) as total_output,
    SUM(input_tokens + output_tokens) as total_tokens,
    ROUND(AVG(input_tokens + output_tokens), 0) as avg_tokens,
    ROUND(SUM(input_tokens + output_tokens) * 100.0 /
        (SELECT SUM(input_tokens + output_tokens) FROM token_usage WHERE created_at >= datetime('now', '-30 days')), 2) as pct_of_total
FROM token_usage
WHERE created_at >= datetime('now', '-30 days')
GROUP BY role
ORDER BY total_tokens DESC;
```

#### 3.2 Cost Estimation

**Add to token_usage table query:**
```sql
-- Estimated cost by role (DeepSeek V3 pricing: $0.27/M input, $1.10/M output)
SELECT
    role,
    COUNT(*) as calls,
    ROUND(SUM(input_tokens) / 1000000.0 * 0.27, 4) as input_cost_usd,
    ROUND(SUM(output_tokens) / 1000000.0 * 1.10, 4) as output_cost_usd,
    ROUND((SUM(input_tokens) / 1000000.0 * 0.27) + (SUM(output_tokens) / 1000000.0 * 1.10), 4) as total_cost_usd
FROM token_usage
WHERE created_at >= datetime('now', '-30 days')
GROUP BY role
ORDER BY total_cost_usd DESC;
```

---

### 4. Memory & Knowledge Queries

#### 4.1 Memory Utilization

**File System Checks:**
```powershell
# Mental models count
$hotModels = (Get-ChildItem "$MEMORY_DIR\models" -File -ErrorAction SilentlyContinue).Count
$deepModels = (Get-ChildItem "$MEMORY_DIR\deep" -File -ErrorAction SilentlyContinue).Count

Write-Host "Hot Memory Models: $hotModels"
Write-Host "Deep Memory Models: $deepModels"

# Knowledge base size
$knowledgeDocs = (Get-ChildItem "$env:USERPROFILE\.bot\knowledge" -Recurse -File -ErrorAction SilentlyContinue).Count
Write-Host "General Knowledge Docs: $knowledgeDocs"

# Persona-specific knowledge
Get-ChildItem "$env:USERPROFILE\.bot\personas\*\knowledge" -Directory -ErrorAction SilentlyContinue |
    ForEach-Object {
        $count = (Get-ChildItem $_.FullName -File).Count
        Write-Host "$($_.Parent.Name): $count knowledge docs"
    }
```

---

### 5. Security & Compliance Checks

#### 5.1 Credential Security Audit

**Vault File Inspection:**
```powershell
# Check vault file format (should only contain srv: prefixed encrypted blobs)
$vault = Get-Content $VAULT_FILE -ErrorAction SilentlyContinue | ConvertFrom-Json

$vault.PSObject.Properties | ForEach-Object {
    $domain = $_.Name
    $blob = $_.Value
    if ($blob -notmatch '^srv:') {
        Write-Warning "SECURITY ALERT: Domain '$domain' has unencrypted credential!"
    }
}

Write-Host "Vault contains $($vault.PSObject.Properties.Count) credential blobs"
```

#### 5.2 Authentication Events

```sql
-- Failed authentication attempts (last 7 days)
SELECT
    event_type,
    DATE(created_at) as date,
    COUNT(*) as event_count
FROM auth_events
WHERE created_at >= datetime('now', '-7 days')
GROUP BY event_type, DATE(created_at)
ORDER BY date DESC, event_count DESC;

-- Device registration summary
SELECT
    device_name,
    created_at,
    last_seen_at
FROM devices
ORDER BY last_seen_at DESC;
```

---

### 6. Disk Usage Monitoring

```powershell
# Disk usage report for all DotBot storage
function Get-DotBotDiskUsage {
    $locations = @{
        'Memory' = "$env:USERPROFILE\.bot\memory"
        'Workspaces' = "$env:USERPROFILE\.bot\agent-workspaces"
        'Knowledge' = "$env:USERPROFILE\.bot\knowledge"
        'Personas' = "$env:USERPROFILE\.bot\personas"
        'Vault' = "$env:USERPROFILE\.bot\vault.json"
        'Reminders' = "$env:USERPROFILE\.bot\reminders.json"
        'Scheduled Tasks' = "$env:USERPROFILE\.bot\scheduled-tasks.json"
        'Heartbeat Log' = "$env:USERPROFILE\.bot\heartbeat-log.jsonl"
        'Server Database' = "$env:USERPROFILE\.bot\server-data\dotbot.db"
    }

    foreach ($name in $locations.Keys) {
        $path = $locations[$name]
        if (Test-Path $path) {
            if ((Get-Item $path) -is [System.IO.DirectoryInfo]) {
                $size = (Get-ChildItem $path -Recurse -File -ErrorAction SilentlyContinue |
                    Measure-Object -Property Length -Sum).Sum / 1MB
                Write-Host "$name : $($size.ToString('0.00')) MB"
            } else {
                $size = (Get-Item $path).Length / 1KB
                Write-Host "$name : $($size.ToString('0.00')) KB"
            }
        } else {
            Write-Host "$name : Not found"
        }
    }
}

Get-DotBotDiskUsage
```

---

### 7. Automated Daily Report Script

**Create `scripts/daily-kpi-report.ps1`:**
```powershell
#!/usr/bin/env pwsh
# Daily KPI Report for DotBot
# Run this from Task Scheduler or cron for daily monitoring

$DB_PATH = "$env:USERPROFILE\.bot\server-data\dotbot.db"
$REPORT_DATE = Get-Date -Format "yyyy-MM-dd"
$REPORT_FILE = "$env:USERPROFILE\.bot\kpi-reports\daily-$REPORT_DATE.md"

# Create report directory
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.bot\kpi-reports" | Out-Null

# Start report
@"
# DotBot Daily KPI Report - $REPORT_DATE

Generated: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")

---

## 1. Pipeline Reliability (P0)

"@ | Out-File $REPORT_FILE

# Task completion (last 24 hours)
$taskCount = sqlite3 $DB_PATH "SELECT COUNT(*) FROM token_usage WHERE created_at >= datetime('now', '-1 day');"
"- Total tasks (24h): $taskCount" | Out-File $REPORT_FILE -Append

# Heartbeat success rate
$heartbeats = Get-Content "$env:USERPROFILE\.bot\heartbeat-log.jsonl" -Tail 100 |
    ForEach-Object { $_ | ConvertFrom-Json } |
    Where-Object { [DateTime]$_.timestamp -gt (Get-Date).AddDays(-1) }

$successRate = (($heartbeats | Where-Object status -in @('ok','alert')).Count / $heartbeats.Count * 100)
"- Heartbeat success rate: $($successRate.ToString('0.00'))%" | Out-File $REPORT_FILE -Append

# Add more sections as needed...

Write-Host "Daily report generated: $REPORT_FILE"
```

---

### 8. Monitoring Dashboard (Future Implementation)

**Recommended Architecture:**

```
┌─────────────────────────────────────────────────┐
│ Data Collection Layer                           │
│ ┌─────────────┐ ┌──────────────┐ ┌───────────┐ │
│ │ SQLite      │ │ JSONL Parsers│ │ Filesystem│ │
│ │ Queries     │ │ (heartbeat,  │ │ Watchers  │ │
│ │             │ │  tool-calls) │ │           │ │
│ └──────┬──────┘ └──────┬───────┘ └─────┬─────┘ │
└────────┼───────────────┼───────────────┼────────┘
         │               │               │
         └───────────────┴───────────────┘
                         │
         ┌───────────────▼────────────────┐
         │ Aggregation Service            │
         │ (Node.js/Python cron job)      │
         │ - Runs every 5 minutes         │
         │ - Executes all KPI queries     │
         │ - Writes to time-series DB     │
         └───────────────┬────────────────┘
                         │
         ┌───────────────▼────────────────┐
         │ Storage                        │
         │ - SQLite time-series table     │
         │ - OR InfluxDB/Prometheus       │
         └───────────────┬────────────────┘
                         │
         ┌───────────────▼────────────────┐
         │ Visualization                  │
         │ - Grafana dashboard            │
         │ - OR custom web UI             │
         │ - Real-time alerts via Discord │
         └────────────────────────────────┘
```

**Minimal Implementation (SQLite-based):**

Create a `kpi_snapshots` table:
```sql
CREATE TABLE IF NOT EXISTS kpi_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    metric_name TEXT NOT NULL,
    metric_value REAL NOT NULL,
    metric_metadata TEXT, -- JSON blob for additional context
    INDEX idx_metric_time (metric_name, timestamp)
);
```

**Cron job to populate:**
```javascript
// scripts/kpi-collector.js
import Database from 'better-sqlite3';
import { collectAllKPIs } from './kpi-queries.js';

const db = new Database(process.env.HOME + '/.bot/server-data/dotbot.db');

async function recordKPISnapshot(metricName, value, metadata = null) {
    db.prepare(`
        INSERT INTO kpi_snapshots (metric_name, metric_value, metric_metadata)
        VALUES (?, ?, ?)
    `).run(metricName, value, JSON.stringify(metadata));
}

// Run all KPI queries and record snapshots
const kpis = await collectAllKPIs();
for (const [name, value] of Object.entries(kpis)) {
    await recordKPISnapshot(name, value);
}
```

---

### 9. Alert Configuration (Discord Integration)

**Example Alert Script:**
```javascript
// scripts/kpi-alerts.js
import { sendDiscordAlert } from '../server/src/adapters/discord.js';

const thresholds = {
    'heartbeat_success_rate': { min: 95, priority: 'P0' },
    'tool_success_rate': { min: 95, priority: 'P0' },
    'task_completion_rate': { min: 90, priority: 'P0' },
    'disk_usage_mb': { max: 500, priority: 'P1' }
};

async function checkAndAlert(metricName, currentValue) {
    const threshold = thresholds[metricName];
    if (!threshold) return;

    if (threshold.min && currentValue < threshold.min) {
        await sendDiscordAlert(`
🚨 **${threshold.priority} Alert: ${metricName}**
Current: ${currentValue}
Threshold: ≥ ${threshold.min}
        `);
    }

    if (threshold.max && currentValue > threshold.max) {
        await sendDiscordAlert(`
⚠️ **${threshold.priority} Alert: ${metricName}**
Current: ${currentValue}
Threshold: ≤ ${threshold.max}
        `);
    }
}
```

---

### 10. Quick Reference: Common Commands

**Daily Health Check:**
```powershell
# One-liner for quick status
sqlite3 "$env:USERPROFILE\.bot\server-data\dotbot.db" "SELECT COUNT(*) as tasks_24h FROM token_usage WHERE created_at >= datetime('now', '-1 day');" &&
Get-Content "$env:USERPROFILE\.bot\heartbeat-log.jsonl" -Tail 20 | Select-String '"status":"error"' | Measure-Object | Select-Object -ExpandProperty Count
```

**Weekly Token Cost:**
```bash
sqlite3 ~/.bot/server-data/dotbot.db <<EOF
SELECT
    ROUND((SUM(input_tokens) / 1000000.0 * 0.27) + (SUM(output_tokens) / 1000000.0 * 1.10), 4) as estimated_cost_usd
FROM token_usage
WHERE created_at >= datetime('now', '-7 days');
EOF
```

**Memory Growth Check:**
```powershell
Get-ChildItem "$env:USERPROFILE\.bot\memory\models" |
    Group-Object { $_.LastWriteTime.ToString('yyyy-MM-dd') } |
    Select-Object Name, Count |
    Sort-Object Name -Descending |
    Select-Object -First 7
```

---

*This document should be reviewed and updated as DotBot evolves. KPIs that consistently show green can be moved to monthly checks. New capabilities should have KPIs added when shipped.*
