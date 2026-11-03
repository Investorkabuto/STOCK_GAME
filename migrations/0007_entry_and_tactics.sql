-- エントリー銘柄（登録時に選ぶ初回購入）と、毎日の作戦コマンド
-- agents.entry_json: 登録時のエントリー（初回の買い注文と初回の作戦）。entry_placed_at: 初回の注文を出した時刻
ALTER TABLE agents ADD COLUMN entry_json TEXT;
ALTER TABLE agents ADD COLUMN entry_placed_at TEXT;

-- 作戦の宣言。その取引日の寄付きの締切（8:00）までの宣言が、その日の作戦になる
CREATE TABLE daily_tactics (
  realm       TEXT NOT NULL,
  agent_id    TEXT NOT NULL REFERENCES agents (id),
  trade_date  TEXT NOT NULL,
  tactic      TEXT NOT NULL CHECK (tactic IN ('gangan', 'inochi', 'iroiro')),
  chosen_by   TEXT NOT NULL CHECK (chosen_by IN ('owner', 'ai')),
  declared_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, trade_date)
);
