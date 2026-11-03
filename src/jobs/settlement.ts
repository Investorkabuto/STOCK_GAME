// セッション（取引日 × 寄付き／引け）の約定と精算。
// 1セッション分の書き込みは D1 の batch で一括実行する（途中で失敗すれば全体が取り消される）。
import type { Realm } from '../env';
import { eventStatement, lastCloses, loadAccount, saveAccountStatements, type OrderRow } from '../db/repo';
import {
  marketValue,
  rankByTotal,
  settleSession,
  type AccountState,
  type OrderResult,
  type PriceInfo,
} from '../lib/engine';
import { jstIso, type Timing } from '../lib/time';

interface PriceRow {
  ticker: string;
  open: number | null;
  close: number | null;
  open_status: 'ok' | 'no_trade' | null;
  close_status: 'ok' | 'no_trade' | null;
}

/** このセッションの精算に価格が必要な銘柄（引けは評価のため保有銘柄も含む） */
export async function requiredTickers(db: D1Database, realm: Realm, tradeDate: string, timing: Timing): Promise<string[]> {
  const fromOrders = await db
    .prepare("SELECT DISTINCT ticker FROM orders WHERE realm = ? AND trade_date = ? AND timing = ? AND status = 'locked'")
    .bind(realm, tradeDate, timing)
    .all<{ ticker: string }>();
  const set = new Set(fromOrders.results.map((r) => r.ticker));
  if (timing === 'close') {
    const held = await db
      .prepare(
        `SELECT DISTINCT h.ticker FROM holdings h
         JOIN accounts a ON a.id = h.account_id JOIN seasons s ON s.id = a.season_id
         WHERE s.realm = ? AND s.status = 'running'`,
      )
      .bind(realm)
      .all<{ ticker: string }>();
    for (const r of held.results) set.add(r.ticker);
  }
  return [...set].sort();
}

async function priceRows(db: D1Database, tickers: string[], tradeDate: string): Promise<Map<string, PriceRow>> {
  const out = new Map<string, PriceRow>();
  for (let i = 0; i < tickers.length; i += 50) {
    const chunk = tickers.slice(i, i + 50);
    const r = await db
      .prepare(`SELECT ticker, open, close, open_status, close_status FROM prices WHERE trade_date = ? AND ticker IN (${chunk.map(() => '?').join(',')})`)
      .bind(tradeDate, ...chunk)
      .all<PriceRow>();
    for (const row of r.results) out.set(row.ticker, row);
  }
  return out;
}

/** 必要な価格のうち、まだ取得できていない銘柄 */
export async function missingTickers(db: D1Database, realm: Realm, tradeDate: string, timing: Timing): Promise<string[]> {
  const need = await requiredTickers(db, realm, tradeDate, timing);
  const rows = await priceRows(db, need, tradeDate);
  return need.filter((t) => {
    const r = rows.get(t);
    return !r || (timing === 'open' ? r.open_status : r.close_status) === null;
  });
}

/** 約定結果を書き込む文と、参加AIへのイベント */
function resultStatements(db: D1Database, orders: Map<string, OrderRow>, results: OrderResult[], tradeDate: string, nowMs: number): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  const now = jstIso(nowMs);
  for (const r of results) {
    const o = orders.get(r.orderId)!;
    if (r.status === 'filled') {
      stmts.push(
        db.prepare("UPDATE orders SET status = 'filled', updated_at = ? WHERE id = ?").bind(now, r.orderId),
        db.prepare('INSERT INTO executions (order_id, trade_date, price, quantity, amount) VALUES (?, ?, ?, ?, ?)').bind(r.orderId, tradeDate, r.price, r.quantity, r.amount),
        eventStatement(db, o.agent_id, 'order.filled', { order_id: r.orderId, ticker: o.ticker, side: o.side, timing: o.timing, trade_date: tradeDate, price: r.price, quantity: r.quantity, amount: r.amount }, nowMs),
      );
    } else {
      stmts.push(
        db.prepare("UPDATE orders SET status = 'expired', expire_reason = ?, updated_at = ? WHERE id = ?").bind(r.reason, now, r.orderId),
        eventStatement(db, o.agent_id, 'order.expired', { order_id: r.orderId, ticker: o.ticker, side: o.side, timing: o.timing, trade_date: tradeDate, reason: r.reason }, nowMs),
      );
    }
  }
  return stmts;
}

function groupByAccount(orders: OrderRow[]): Map<number, OrderRow[]> {
  const m = new Map<number, OrderRow[]>();
  for (const o of orders) m.set(o.account_id, [...(m.get(o.account_id) ?? []), o]);
  return m;
}

const toEngine = (o: OrderRow) => ({ id: o.id, side: o.side, ticker: o.ticker, quantity: o.quantity, amount: o.amount, receivedMs: o.received_ms });

/**
 * 本番セッションを精算する。価格がそろっていなければ何もせず false を返す。
 * 引けの精算では、全口座の日次スナップショットと順位も確定させる。
 */
export async function settleLiveSession(db: D1Database, tradeDate: string, timing: Timing, nowMs: number): Promise<boolean> {
  const realm: Realm = 'live';
  if ((await missingTickers(db, realm, tradeDate, timing)).length > 0) return false;

  const orders = (
    await db
      .prepare("SELECT * FROM orders WHERE realm = ? AND trade_date = ? AND timing = ? AND status = 'locked'")
      .bind(realm, tradeDate, timing)
      .all<OrderRow>()
  ).results;
  const need = await requiredTickers(db, realm, tradeDate, timing);
  const rows = await priceRows(db, need, tradeDate);
  const priceOf = (t: string): PriceInfo => {
    const r = rows.get(t);
    const status = timing === 'open' ? r?.open_status : r?.close_status;
    const price = timing === 'open' ? r?.open : r?.close;
    return status === 'ok' && price != null ? { status: 'ok', price } : { status: 'no_trade' };
  };

  const stmts: D1PreparedStatement[] = [];
  const byId = new Map(orders.map((o) => [o.id, o]));
  const updated = new Map<number, AccountState>();
  for (const [accountId, list] of groupByAccount(orders)) {
    const { account, results } = settleSession(await loadAccount(db, accountId), list.map(toEngine), priceOf);
    updated.set(accountId, account);
    stmts.push(...saveAccountStatements(db, accountId, account), ...resultStatements(db, byId, results, tradeDate, nowMs));
  }

  if (timing === 'close') stmts.push(...(await snapshotStatements(db, tradeDate, updated, nowMs)));

  stmts.push(
    db.prepare("UPDATE sessions SET status = 'settled', settled_at = ? WHERE realm = ? AND trade_date = ? AND timing = ? AND status = 'locked'").bind(jstIso(nowMs), realm, tradeDate, timing),
  );
  await db.batch(stmts);
  return true;
}

/** 引け後の日次スナップショットと順位（失格したAIは順位から外す） */
async function snapshotStatements(db: D1Database, tradeDate: string, updated: Map<number, AccountState>, nowMs: number): Promise<D1PreparedStatement[]> {
  const accounts = (
    await db
      .prepare(
        `SELECT a.id, a.agent_id, a.season_id, g.status AS agent_status FROM accounts a
         JOIN seasons s ON s.id = a.season_id JOIN agents g ON g.id = a.agent_id
         WHERE s.realm = 'live' AND s.status = 'running' AND s.starts_on <= ? AND s.ends_on >= ?`,
      )
      .bind(tradeDate, tradeDate)
      .all<{ id: number; agent_id: string; season_id: string; agent_status: string }>()
  ).results;

  const states = new Map<number, AccountState>();
  for (const a of accounts) states.set(a.id, updated.get(a.id) ?? (await loadAccount(db, a.id)));
  const allTickers = [...new Set([...states.values()].flatMap((s) => [...s.holdings.keys()]))];
  const closes = await lastCloses(db, allTickers, tradeDate);

  const rows = accounts.map((a) => {
    const s = states.get(a.id)!;
    const mv = marketValue(s.holdings, (t) => closes.get(t));
    return { ...a, cash: s.cash, market_value: mv, total: s.cash + mv };
  });
  const ranked = new Map(rankByTotal(rows.filter((r) => r.agent_status !== 'disqualified')).map((r) => [r.id, r.rank]));

  const stmts: D1PreparedStatement[] = [];
  for (const r of rows) {
    const rank = ranked.get(r.id) ?? 0;
    stmts.push(
      db.prepare('INSERT OR REPLACE INTO daily_snapshots (account_id, trade_date, cash, market_value, total, rank) VALUES (?, ?, ?, ?, ?, ?)').bind(r.id, tradeDate, r.cash, r.market_value, r.total, rank),
      eventStatement(db, r.agent_id, 'daily.settled', { trade_date: tradeDate, season_id: r.season_id, cash: r.cash, market_value: r.market_value, total: r.total, rank }, nowMs),
    );
  }
  return stmts;
}

/**
 * サンドボックスの即時精算。呼び出したAIの、指定タイミングの受付済み注文だけを処理する。
 * 価格は指定値 → 直近の実際の終値 → 1,000円 の順で使う。
 */
export async function settleSandbox(
  db: D1Database,
  agentId: string,
  accountId: number,
  timing: Timing,
  overrides: Record<string, number | null>,
  nowMs: number,
): Promise<{ results: OrderResult[]; prices: Record<string, number | null> }> {
  const orders = (
    await db
      .prepare("SELECT * FROM orders WHERE realm = 'sandbox' AND agent_id = ? AND timing = ? AND status IN ('accepted', 'locked')")
      .bind(agentId, timing)
      .all<OrderRow>()
  ).results;
  const tickers = [...new Set(orders.map((o) => o.ticker))];
  const closes = await lastCloses(db, tickers, '9999-12-31');
  const used: Record<string, number | null> = {};
  for (const t of tickers) used[t] = t in overrides ? overrides[t]! : closes.get(t) ?? 1000;
  const priceOf = (t: string): PriceInfo => (used[t] == null ? { status: 'no_trade' } : { status: 'ok', price: used[t]! });

  const { account, results } = settleSession(await loadAccount(db, accountId), orders.map(toEngine), priceOf);
  const byId = new Map(orders.map((o) => [o.id, o]));
  const today = jstIso(nowMs).slice(0, 10);
  await db.batch([...saveAccountStatements(db, accountId, account), ...resultStatements(db, byId, results, today, nowMs)]);
  return { results, prices: used };
}
