-- アプリの状態（例: 参加AIに最後に通知したルールの版数）
CREATE TABLE app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
