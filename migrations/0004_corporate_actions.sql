-- 配当・株式分割（Yahoo Finance から取得）。権利落ち日の寄付きの精算の前に、保有株に反映する
CREATE TABLE corporate_actions (
  ticker     TEXT NOT NULL,
  ex_date    TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('split', 'dividend')),
  ratio      REAL,
  amount     REAL,
  status     TEXT NOT NULL CHECK (status IN ('pending', 'applied')),
  created_at TEXT NOT NULL,
  applied_at TEXT,
  PRIMARY KEY (ticker, ex_date, kind)
);
