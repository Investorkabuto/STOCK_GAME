// D1 への読み書きの共通処理
import type { Realm } from '../env';
import type { AccountState, Holding } from '../lib/engine';
import { jstIso } from '../lib/time';

export interface AgentRow {
  id: string;
  realm: Realm;
  display_name: string;
  profile: string;
  status: 'pending' | 'active' | 'rejected' | 'disqualified';
  review_reason: string | null;
  created_at: string;
  reviewed_at: string | null;
}

export interface SeasonRow {
  id: string;
  realm: Realm;
  starts_on: string;
  ends_on: string;
  status: 'scheduled' | 'running' | 'finished';
}

export interface OrderRow {
  id: string;
  account_id: number;
  agent_id: string;
  realm: Realm;
  trade_date: string;
  timing: 'open' | 'close';
  side: 'buy' | 'sell';
  ticker: string;
  quantity: number | null;
  amount: number | null;
  strategy: string;
  rationale: string;
  status: 'accepted' | 'locked' | 'filled' | 'expired' | 'cancelled';
  expire_reason: string | null;
  received_at: string;
  received_ms: number;
  updated_at: string;
}

export async function holidaySet(db: D1Database): Promise<Set<string>> {
  const r = await db.prepare('SELECT date FROM market_holidays').all<{ date: string }>();
  return new Set(r.results.map((x) => x.date));
}

export async function loadAccount(db: D1Database, accountId: number): Promise<AccountState> {
  const a = await db.prepare('SELECT cash FROM accounts WHERE id = ?').bind(accountId).first<{ cash: number }>();
  if (!a) throw new Error(`account ${accountId} not found`);
  const hs = await db
    .prepare('SELECT ticker, quantity, cost FROM holdings WHERE account_id = ?')
    .bind(accountId)
    .all<{ ticker: string } & Holding>();
  return { cash: a.cash, holdings: new Map(hs.results.map((h) => [h.ticker, { quantity: h.quantity, cost: h.cost }])) };
}

/** 口座の状態を書き戻す文（バッチ用） */
export function saveAccountStatements(db: D1Database, accountId: number, acc: AccountState): D1PreparedStatement[] {
  const stmts = [
    db.prepare('UPDATE accounts SET cash = ? WHERE id = ?').bind(acc.cash, accountId),
    db.prepare('DELETE FROM holdings WHERE account_id = ?').bind(accountId),
  ];
  for (const [ticker, h] of acc.holdings) {
    stmts.push(
      db.prepare('INSERT INTO holdings (account_id, ticker, quantity, cost) VALUES (?, ?, ?, ?)').bind(accountId, ticker, h.quantity, h.cost),
    );
  }
  return stmts;
}

export function eventStatement(db: D1Database, agentId: string, type: string, payload: unknown, nowMs: number): D1PreparedStatement {
  return db
    .prepare('INSERT INTO events (agent_id, type, payload, created_at) VALUES (?, ?, ?, ?)')
    .bind(agentId, type, JSON.stringify(payload), jstIso(nowMs));
}

/** その日付を含む本番シーズン */
export async function seasonForDate(db: D1Database, realm: Realm, date: string): Promise<SeasonRow | null> {
  return db
    .prepare("SELECT * FROM seasons WHERE realm = ? AND starts_on <= ? AND ends_on >= ? AND status != 'finished' ORDER BY starts_on DESC LIMIT 1")
    .bind(realm, date, date)
    .first<SeasonRow>();
}

/** 銘柄ごとの直近の終値（date 以前） */
export async function lastCloses(db: D1Database, tickers: string[], date: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (tickers.length === 0) return out;
  for (let i = 0; i < tickers.length; i += 50) {
    const chunk = tickers.slice(i, i + 50);
    const r = await db
      .prepare(
        `SELECT p.ticker, p.close FROM prices p
         WHERE p.ticker IN (${chunk.map(() => '?').join(',')}) AND p.close_status = 'ok'
           AND p.trade_date = (SELECT MAX(q.trade_date) FROM prices q WHERE q.ticker = p.ticker AND q.close_status = 'ok' AND q.trade_date <= ?)`,
      )
      .bind(...chunk, date)
      .all<{ ticker: string; close: number }>();
    for (const row of r.results) out.set(row.ticker, row.close);
  }
  // 終値の日より後に株式分割が反映されていれば、その終値を分割後の1株あたりに換算する
  const splits = await db
    .prepare(
      `SELECT c.ticker, c.ratio, c.ex_date FROM corporate_actions c
       WHERE c.kind = 'split' AND c.status = 'applied' AND c.ex_date <= ? AND c.ticker IN (${tickers.slice(0, 90).map(() => '?').join(',')})`,
    )
    .bind(date, ...tickers.slice(0, 90))
    .all<{ ticker: string; ratio: number; ex_date: string }>()
    .catch(() => ({ results: [] as { ticker: string; ratio: number; ex_date: string }[] }));
  if (splits.results.length) {
    const closeDates = await db
      .prepare(`SELECT ticker, MAX(trade_date) AS d FROM prices WHERE close_status = 'ok' AND trade_date <= ? AND ticker IN (${splits.results.map(() => '?').join(',')}) GROUP BY ticker`)
      .bind(date, ...splits.results.map((x) => x.ticker))
      .all<{ ticker: string; d: string }>();
    const closeDate = new Map(closeDates.results.map((x) => [x.ticker, x.d]));
    for (const sp of splits.results) {
      const d = closeDate.get(sp.ticker);
      const c = out.get(sp.ticker);
      if (d && c !== undefined && sp.ex_date > d) out.set(sp.ticker, c / sp.ratio);
    }
  }
  return out;
}

export function formatOrder(o: OrderRow, exec?: { price: number; quantity: number; amount: number } | null) {
  return {
    id: o.id,
    trade_date: o.trade_date,
    timing: o.timing,
    side: o.side,
    ticker: o.ticker,
    quantity: o.quantity,
    amount: o.amount,
    strategy: JSON.parse(o.strategy) as string[],
    rationale: o.rationale,
    status: o.status,
    expire_reason: o.expire_reason,
    received_at: o.received_at,
    ...(exec ? { execution: exec } : {}),
  };
}
