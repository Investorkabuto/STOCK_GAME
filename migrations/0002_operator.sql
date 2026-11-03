-- 運営API（もちの接続）。docs/operator-api.md 8章

-- 不正検知の材料: 接続元IPの範囲（IPv4 /24、IPv6 /48）のハッシュ。生のIPは保存しない
ALTER TABLE agents ADD COLUMN ip_prefix_hash TEXT;
ALTER TABLE orders ADD COLUMN ip_prefix_hash TEXT;

CREATE TABLE operator_tasks (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL CHECK (type IN ('registration_review', 'fraud_check', 'report_daily', 'report_weekly', 'season_review', 'appeal_review')),
  status          TEXT NOT NULL CHECK (status IN ('pending', 'done', 'expired')),
  subject_id      TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  due_at          TEXT NOT NULL,
  expires_at      TEXT,
  created_at      TEXT NOT NULL,
  done_at         TEXT,
  result_json     TEXT,
  result_reason   TEXT,
  idempotency_key TEXT,
  response_json   TEXT,               -- 同じ Idempotency-Key での再送に、初回と同じ応答を返すため
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT
);
CREATE INDEX operator_tasks_status ON operator_tasks (status, due_at);
CREATE UNIQUE INDEX operator_tasks_subject ON operator_tasks (type, subject_id);

CREATE TABLE operator_tokens (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT,
  last_seen_at TEXT
);

CREATE TABLE adjudications (
  id                 TEXT PRIMARY KEY,
  agent_id           TEXT NOT NULL REFERENCES agents (id),
  season_id          TEXT,
  level              TEXT NOT NULL CHECK (level IN ('warning', 'disqualification')),
  status             TEXT NOT NULL CHECK (status IN ('published', 'pending_review', 'enforced', 'rejected', 'withdrawn')),
  reason             TEXT NOT NULL,
  evidence_json      TEXT NOT NULL,
  source_task_id     TEXT,
  ban_future_seasons INTEGER NOT NULL DEFAULT 0,
  decided_by         TEXT,             -- operator / admin
  decided_at         TEXT,
  published_at       TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX adjudications_agent ON adjudications (agent_id, created_at);

CREATE TABLE appeals (
  id              TEXT PRIMARY KEY,
  adjudication_id TEXT NOT NULL UNIQUE REFERENCES adjudications (id),  -- 1件の裁定につき1回まで
  agent_id        TEXT NOT NULL REFERENCES agents (id),
  statement       TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('reviewing', 'pending_admin', 'decided')),
  finding         TEXT CHECK (finding IN ('uphold', 'overturn', 'downgrade')),
  operator_reason TEXT,
  task_id         TEXT,
  created_at      TEXT NOT NULL,
  decided_at      TEXT
);

-- 運営AIの記事（日報・週報・シーズン総評・告知・裁定の公示）と、プログラムの簡易版日報
CREATE TABLE reports (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('daily', 'daily_auto', 'weekly', 'season_review', 'season_announcement', 'adjudication')),
  subject       TEXT NOT NULL,         -- 対象日・週・シーズンなど
  title         TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  author        TEXT NOT NULL,         -- operator / system
  source_task_id TEXT,
  status        TEXT NOT NULL CHECK (status IN ('published', 'withdrawn')),
  published_at  TEXT NOT NULL,
  withdrawn_at  TEXT,
  withdraw_note TEXT
);
CREATE INDEX reports_published ON reports (status, published_at);

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor       TEXT NOT NULL CHECK (actor IN ('operator', 'admin', 'system')),
  action      TEXT NOT NULL,
  target      TEXT,
  detail_json TEXT,
  created_at  TEXT NOT NULL,
  created_ms  INTEGER NOT NULL
);
CREATE INDEX audit_log_actor ON audit_log (actor, created_ms);

-- 滞留通知（GitHub Issue）。条件ごとに開いている Issue を覚えておき、重複して作らない
CREATE TABLE alerts (
  key          TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  issue_number INTEGER,
  opened_at    TEXT NOT NULL
);
