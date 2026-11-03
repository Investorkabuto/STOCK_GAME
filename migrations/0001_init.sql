-- STOCK_GAME 初期スキーマ（MVP）
-- realm: 'live'（本番）/ 'sandbox'（練習用。成績に影響しない）
-- 金額は整数（円）。株価は小数を含みうるため REAL で持ち、金額計算時に丸める。

CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  realm           TEXT NOT NULL CHECK (realm IN ('live', 'sandbox')),
  display_name    TEXT NOT NULL,
  profile         TEXT NOT NULL DEFAULT '',
  api_key_hash    TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'active', 'rejected', 'disqualified')),
  review_reason   TEXT,
  cluster_ref     TEXT,
  terms_agreed_at TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  reviewed_at     TEXT
);
CREATE UNIQUE INDEX agents_name_realm ON agents (realm, display_name);

CREATE TABLE seasons (
  id         TEXT PRIMARY KEY,
  realm      TEXT NOT NULL,
  starts_on  TEXT NOT NULL,           -- YYYY-MM-DD（含む）
  ends_on    TEXT NOT NULL,           -- YYYY-MM-DD（含む）
  status     TEXT NOT NULL CHECK (status IN ('scheduled', 'running', 'finished')),
  created_at TEXT NOT NULL
);

CREATE TABLE accounts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id  TEXT NOT NULL REFERENCES seasons (id),
  agent_id   TEXT NOT NULL REFERENCES agents (id),
  cash       INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (season_id, agent_id)
);

CREATE TABLE holdings (
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  ticker     TEXT NOT NULL,
  quantity   INTEGER NOT NULL,
  cost       INTEGER NOT NULL,         -- 取得総額（円）。平均取得単価 = cost / quantity
  PRIMARY KEY (account_id, ticker)
);

CREATE TABLE orders (
  id              TEXT PRIMARY KEY,
  account_id      INTEGER NOT NULL REFERENCES accounts (id),
  agent_id        TEXT NOT NULL REFERENCES agents (id),
  realm           TEXT NOT NULL,
  trade_date      TEXT NOT NULL,
  timing          TEXT NOT NULL CHECK (timing IN ('open', 'close')),
  side            TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  ticker          TEXT NOT NULL,
  quantity        INTEGER,
  amount          INTEGER,
  strategy        TEXT NOT NULL,       -- JSON 配列
  rationale       TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('accepted', 'locked', 'filled', 'expired', 'cancelled')),
  expire_reason   TEXT,
  idempotency_key TEXT,
  received_at     TEXT NOT NULL,
  received_ms     INTEGER NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX orders_session ON orders (realm, trade_date, timing, status);
CREATE INDEX orders_agent ON orders (agent_id, trade_date);
CREATE UNIQUE INDEX orders_idem ON orders (agent_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE executions (
  order_id   TEXT PRIMARY KEY REFERENCES orders (id),
  trade_date TEXT NOT NULL,
  price      REAL NOT NULL,
  quantity   INTEGER NOT NULL,
  amount     INTEGER NOT NULL
);

-- 1営業日 × 寄付き／引け の取引セッション
CREATE TABLE sessions (
  realm      TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  timing     TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('locked', 'settled')),
  locked_at  TEXT NOT NULL,
  settled_at TEXT,
  PRIMARY KEY (realm, trade_date, timing)
);

-- open_status / close_status: NULL = 未取得, 'ok' = 値あり, 'no_trade' = 値が付かなかった
CREATE TABLE prices (
  ticker       TEXT NOT NULL,
  trade_date   TEXT NOT NULL,
  open         REAL,
  close        REAL,
  open_status  TEXT CHECK (open_status IN ('ok', 'no_trade')),
  close_status TEXT CHECK (close_status IN ('ok', 'no_trade')),
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (ticker, trade_date)
);

CREATE TABLE daily_snapshots (
  account_id   INTEGER NOT NULL REFERENCES accounts (id),
  trade_date   TEXT NOT NULL,
  cash         INTEGER NOT NULL,
  market_value INTEGER NOT NULL,
  total        INTEGER NOT NULL,
  rank         INTEGER NOT NULL,
  PRIMARY KEY (account_id, trade_date)
);

CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX events_agent ON events (agent_id, id);

CREATE TABLE challenges (
  nonce        TEXT PRIMARY KEY,
  answer       TEXT NOT NULL,
  issued_ms    INTEGER NOT NULL,
  used         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tickers (
  code   TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  market TEXT NOT NULL
);

-- 土日以外の休場日（祝日・振替休日・年末年始）。毎年、JPXの公表に合わせて追加・確認する
CREATE TABLE market_holidays (
  date TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

INSERT INTO market_holidays (date, name) VALUES
  ('2026-01-01', '元日'),
  ('2026-01-02', '年始休業'),
  ('2026-01-12', '成人の日'),
  ('2026-02-11', '建国記念の日'),
  ('2026-02-23', '天皇誕生日'),
  ('2026-03-20', '春分の日'),
  ('2026-04-29', '昭和の日'),
  ('2026-05-04', 'みどりの日'),
  ('2026-05-05', 'こどもの日'),
  ('2026-05-06', '振替休日'),
  ('2026-07-20', '海の日'),
  ('2026-08-11', '山の日'),
  ('2026-09-21', '敬老の日'),
  ('2026-09-22', '国民の休日'),
  ('2026-09-23', '秋分の日'),
  ('2026-10-12', 'スポーツの日'),
  ('2026-11-03', '文化の日'),
  ('2026-11-23', '勤労感謝の日'),
  ('2026-12-31', '年末休業'),
  ('2027-01-01', '元日'),
  ('2027-01-11', '成人の日'),
  ('2027-02-11', '建国記念の日'),
  ('2027-02-23', '天皇誕生日'),
  ('2027-03-22', '振替休日'),
  ('2027-04-29', '昭和の日'),
  ('2027-05-03', '憲法記念日'),
  ('2027-05-04', 'みどりの日'),
  ('2027-05-05', 'こどもの日'),
  ('2027-07-19', '海の日'),
  ('2027-08-11', '山の日'),
  ('2027-09-20', '敬老の日'),
  ('2027-09-23', '秋分の日'),
  ('2027-10-11', 'スポーツの日'),
  ('2027-11-03', '文化の日'),
  ('2027-11-23', '勤労感謝の日'),
  ('2027-12-31', '年末休業');
