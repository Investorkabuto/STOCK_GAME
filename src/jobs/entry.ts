// エントリー（参加登録のときに選んだ銘柄の初回購入）と、毎日の作戦の宣言
import { SANDBOX_SEASON_ID, type Realm, type Tactic } from '../env';
import { eventStatement, holidaySet } from '../db/repo';
import { newId } from '../lib/crypto';
import { jstIso, nextEligibleTradeDate } from '../lib/time';

export interface EntryOrder {
  ticker: string;
  quantity: number | null;
  amount: number | null;
  rationale: string;
}

export interface Entry {
  orders: EntryOrder[];
  tactic: Tactic;
  tactic_by: 'owner' | 'ai';
}

/** 作戦の宣言（同じ取引日は上書き）。寄付きの締切（8:45）までに出した宣言が、その日の作戦になる */
export function tacticStatement(db: D1Database, realm: Realm, agentId: string, tradeDate: string, tactic: Tactic, by: 'owner' | 'ai', nowMs: number) {
  return db
    .prepare(
      `INSERT INTO daily_tactics (realm, agent_id, trade_date, tactic, chosen_by, declared_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent_id, trade_date) DO UPDATE SET tactic = excluded.tactic, chosen_by = excluded.chosen_by, declared_at = excluded.declared_at`,
    )
    .bind(realm, agentId, tradeDate, tactic, by, jstIso(nowMs));
}

/**
 * エントリーの初回購入を、注文として出す。口座ができていれば（参加が始まっていれば）出し、まだなら次の機会を待つ。
 * 登録の直後と、定時処理（承認・大会の開始・テスト運用への途中参加のあと）の両方から呼ぶ。何度呼んでも二重には出さない
 */
export async function placeEntries(db: D1Database, nowMs: number, agentId?: string): Promise<string[]> {
  const pending = (
    await db
      .prepare(
        `SELECT id, realm, entry_json FROM agents WHERE status = 'active' AND entry_json IS NOT NULL AND entry_placed_at IS NULL${agentId ? ' AND id = ?' : ''}`,
      )
      .bind(...(agentId ? [agentId] : []))
      .all<{ id: string; realm: Realm; entry_json: string }>()
  ).results;
  if (pending.length === 0) return [];
  const holidays = await holidaySet(db);
  const tradeDate = nextEligibleTradeDate(nowMs, 'open', holidays);
  const log: string[] = [];
  for (const a of pending) {
    const acc =
      a.realm === 'sandbox'
        ? await db.prepare('SELECT id FROM accounts WHERE season_id = ? AND agent_id = ?').bind(SANDBOX_SEASON_ID, a.id).first<{ id: number }>()
        : await db
            .prepare("SELECT a.id FROM accounts a JOIN seasons s ON s.id = a.season_id WHERE a.agent_id = ? AND s.realm = 'live' AND s.status = 'running' AND s.starts_on <= ? AND s.ends_on >= ?")
            .bind(a.id, tradeDate, tradeDate)
            .first<{ id: number }>();
    if (!acc) continue;
    const entry = JSON.parse(a.entry_json) as Entry;
    const now = jstIso(nowMs);
    const ids: string[] = [];
    const stmts: D1PreparedStatement[] = [];
    for (const o of entry.orders) {
      const id = newId('ord', nowMs);
      ids.push(id);
      stmts.push(
        db
          .prepare(
            `INSERT INTO orders (id, account_id, agent_id, realm, trade_date, timing, side, ticker, quantity, amount, strategy, rationale, status, idempotency_key, received_at, received_ms, updated_at)
             VALUES (?, ?, ?, ?, ?, 'open', 'buy', ?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?)`,
          )
          .bind(id, acc.id, a.id, a.realm, tradeDate, o.ticker, o.quantity, o.amount, '[]', o.rationale, `entry:${o.ticker}`, now, nowMs, now),
        eventStatement(db, a.id, 'order.accepted', { order_id: id, ticker: o.ticker, side: 'buy', timing: 'open', trade_date: tradeDate, entry: true }, nowMs),
      );
    }
    stmts.push(
      tacticStatement(db, a.realm, a.id, tradeDate, entry.tactic, entry.tactic_by, nowMs),
      db.prepare('UPDATE agents SET entry_placed_at = ? WHERE id = ? AND entry_placed_at IS NULL').bind(now, a.id),
      eventStatement(db, a.id, 'entry.placed', { trade_date: tradeDate, order_ids: ids, tactic: entry.tactic }, nowMs),
    );
    await db.batch(stmts);
    log.push(`entry placed: ${a.id} (${ids.length} orders for ${tradeDate})`);
  }
  return log;
}
