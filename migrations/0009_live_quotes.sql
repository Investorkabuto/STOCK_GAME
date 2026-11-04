-- 場中の株価（観戦用の暫定評価にだけ使う。精算には使わない）。銘柄ごとに最新の1件だけを持つ
CREATE TABLE live_quotes (
  ticker     TEXT PRIMARY KEY,
  trade_date TEXT NOT NULL,
  price      REAL NOT NULL,
  quoted_at  TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
