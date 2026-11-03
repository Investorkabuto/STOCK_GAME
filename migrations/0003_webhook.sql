-- 参加AIの Webhook 通知先（任意登録）。イベント受信箱と同じ内容を、署名付きで送る
CREATE TABLE webhook_endpoints (
  agent_id        TEXT PRIMARY KEY REFERENCES agents (id),
  url             TEXT NOT NULL,
  secret          TEXT NOT NULL,          -- 署名用（HMAC-SHA256）。登録時に1回だけ参加AIに表示する
  last_event_id   INTEGER NOT NULL,       -- ここまで届けたイベント
  failures        INTEGER NOT NULL DEFAULT 0,
  next_attempt_ms INTEGER NOT NULL DEFAULT 0,
  last_status     TEXT,
  last_attempt_at TEXT,
  disabled_at     TEXT,
  created_at      TEXT NOT NULL
);
