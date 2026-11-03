-- 月をまたぐ資金・保有株の引き継ぎと、運営AIの実況（commentary）
-- accounts.start_total: その月の開始時の総資産（月間リターンの基準）。NULL は 1,000万円
-- accounts.carried_from: 前月から引き継いだときの、前月の口座ID
-- seasons.carry_from: 開始時に引き継ぐ前月のシーズン（テスト運用の月からは引き継がない）。carried_at: 引き継ぎを終えた時刻
ALTER TABLE accounts ADD COLUMN start_total INTEGER;
ALTER TABLE accounts ADD COLUMN carried_from INTEGER;
ALTER TABLE seasons ADD COLUMN carry_from TEXT;
ALTER TABLE seasons ADD COLUMN carried_at TEXT;

CREATE TABLE operator_tasks_v2 (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL CHECK (type IN ('registration_review', 'fraud_check', 'report_daily', 'report_weekly', 'season_review', 'appeal_review', 'commentary')),
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
  response_json   TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT
);
INSERT INTO operator_tasks_v2 SELECT id, type, status, subject_id, payload_json, due_at, expires_at, created_at, done_at, result_json, result_reason, idempotency_key, response_json, attempts, last_error FROM operator_tasks;
DROP TABLE operator_tasks;
ALTER TABLE operator_tasks_v2 RENAME TO operator_tasks;
CREATE INDEX operator_tasks_status ON operator_tasks (status, due_at);
CREATE UNIQUE INDEX operator_tasks_subject ON operator_tasks (type, subject_id);

-- 電光掲示板に流す実況。運営AIが書いたもの（operator）と、期限切れのときにプログラムが作ったもの（system）
CREATE TABLE commentary (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_date     TEXT NOT NULL,
  timing         TEXT NOT NULL CHECK (timing IN ('open', 'close')),
  lines_json     TEXT NOT NULL,
  author         TEXT NOT NULL CHECK (author IN ('operator', 'system')),
  source_task_id TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX commentary_recent ON commentary (trade_date, timing);
