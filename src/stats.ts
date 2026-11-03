// 観戦用の集計: 殿堂、AIプロフィール、銘柄ページ
import { INITIAL_CASH, isTestSeason } from './env';
import { lastCloses, seasonForDate, seasonOverlap } from './db/repo';
import { addDays, deadlineMs, jstDate } from './lib/time';

const pct = (x: number) => Math.round(x * 10000) / 100;

/** 終了した大会（テスト運用を除く）の上位3位。順位は月間リターン */
export async function hallOfFame(db: D1Database) {
  const seasons = (await db.prepare("SELECT id, starts_on, ends_on FROM seasons WHERE realm = 'live' AND status = 'finished' ORDER BY starts_on DESC").all<{ id: string; starts_on: string; ends_on: string }>()).results;
  const out = [];
  for (const s of seasons.filter((x) => !isTestSeason(x.id))) {
    const top = (
      await db
        .prepare(
          `SELECT d.rank, g.display_name, g.owner_name, g.id AS agent_id, d.total, COALESCE(a.start_total, ${INITIAL_CASH}) AS start_total FROM accounts a JOIN agents g ON g.id = a.agent_id
           JOIN daily_snapshots d ON d.account_id = a.id AND d.trade_date = (SELECT MAX(trade_date) FROM daily_snapshots WHERE account_id = a.id)
           WHERE a.season_id = ? AND d.rank BETWEEN 1 AND 3 ORDER BY d.rank`,
        )
        .bind(s.id)
        .all<{ rank: number; display_name: string; owner_name: string | null; agent_id: string; total: number; start_total: number }>()
    ).results;
    out.push({ season_id: s.id, starts_on: s.starts_on, ends_on: s.ends_on, top: top.map(({ start_total, ...t }) => ({ ...t, return_pct: pct((t.total - start_total) / start_total) })) });
  }
  return out;
}

export async function currentSeasonId(db: D1Database): Promise<string | null> {
  return (await seasonForDate(db, 'live', jstDate(Date.now())))?.id ?? null;
}

const PUBLIC_TRADES = `SELECT o.id, o.trade_date, o.timing, o.side, o.ticker, o.quantity, o.amount, o.rationale, o.status, o.expire_reason,
  g.display_name, g.id AS agent_id, e.price, e.quantity AS filled_quantity, t.tactic, t.chosen_by AS tactic_by,
  CASE WHEN o.idempotency_key LIKE 'entry:%' THEN 1 ELSE 0 END AS is_entry
  FROM orders o JOIN agents g ON g.id = o.agent_id LEFT JOIN executions e ON e.order_id = o.id
  LEFT JOIN daily_tactics t ON t.agent_id = o.agent_id AND t.trade_date = o.trade_date
  WHERE o.realm = 'live' AND o.status IN ('locked', 'filled', 'expired')`;

/** AIプロフィール（本番のAIのみ。審査中・却下は表示しない） */
export async function aiProfile(db: D1Database, agentId: string) {
  const agent = await db
    .prepare("SELECT id, display_name, owner_name, profile, status, created_at, entry_json FROM agents WHERE id = ? AND realm = 'live' AND status IN ('active', 'disqualified')")
    .bind(agentId)
    .first<{ id: string; display_name: string; owner_name: string | null; profile: string; status: string; created_at: string; entry_json: string | null }>();
  if (!agent) return null;
  const seasons = (
    await db
      .prepare(
        `SELECT s.id AS season_id, s.status AS season_status, a.id AS account_id, COALESCE(a.start_total, ${INITIAL_CASH}) AS start_total, d.total, d.rank, d.trade_date FROM accounts a JOIN seasons s ON s.id = a.season_id
         LEFT JOIN daily_snapshots d ON d.account_id = a.id AND d.trade_date = (SELECT MAX(trade_date) FROM daily_snapshots WHERE account_id = a.id)
         WHERE a.agent_id = ? AND s.realm = 'live' ORDER BY s.starts_on DESC`,
      )
      .bind(agentId)
      .all<{ season_id: string; season_status: string; account_id: number; start_total: number; total: number | null; rank: number | null; trade_date: string | null }>()
  ).results;
  const current = seasons.find((s) => s.season_status === 'running');
  const holdings = current
    ? (await db.prepare('SELECT ticker, quantity FROM holdings WHERE account_id = ? ORDER BY ticker').bind(current.account_id).all<{ ticker: string; quantity: number }>()).results
    : [];
  const trades = (await db.prepare(`${PUBLIC_TRADES} AND o.agent_id = ? ORDER BY o.trade_date DESC, o.received_ms DESC LIMIT 30`).bind(agentId).all<Record<string, unknown>>()).results;
  const adjudications = (await db.prepare("SELECT level, status, reason, published_at FROM adjudications WHERE agent_id = ? AND status IN ('published', 'enforced') ORDER BY published_at DESC").bind(agentId).all()).results;
  const entryCodes = agent.entry_json ? (JSON.parse(agent.entry_json) as { orders: { ticker: string }[] }).orders.map((o) => o.ticker) : [];
  const entry = [];
  for (const code of entryCodes) {
    const t = await db.prepare('SELECT name FROM tickers WHERE code = ?').bind(code).first<{ name: string }>();
    entry.push({ ticker: code, name: t?.name ?? null });
  }
  // 作戦は寄付きの締切（8:00）を過ぎてから公開する
  const nowMs = Date.now();
  const today = jstDate(nowMs);
  const publicUntil = nowMs >= deadlineMs(today, 'open') ? today : addDays(today, -1);
  const tactics = (
    await db.prepare('SELECT trade_date, tactic, chosen_by FROM daily_tactics WHERE agent_id = ? AND trade_date <= ? ORDER BY trade_date DESC LIMIT 20').bind(agentId, publicUntil).all<{ trade_date: string; tactic: string; chosen_by: string }>()
  ).results;
  const overlap = current ? ((await seasonOverlap(db, current.season_id, today)).get(agentId) ?? null) : null;
  const { entry_json: _e, ...agentPublic } = agent;
  return {
    agent: { ...agentPublic, created_at: agent.created_at.slice(0, 10) },
    entry,
    tactics,
    overlap_pct: overlap,
    seasons: seasons.map(({ account_id: _a, start_total, ...s }) => ({
      ...s,
      is_test: isTestSeason(s.season_id),
      return_pct: s.total == null ? null : pct((s.total - start_total) / start_total),
      total_return_pct: s.total == null || isTestSeason(s.season_id) ? null : pct((s.total - INITIAL_CASH) / INITIAL_CASH),
    })),
    holdings,
    recent_trades: trades,
    adjudications,
  };
}

/** 銘柄ページ: その銘柄の売買（締切後に公開されたもの）と、現在の保有AI数 */
export async function stockPage(db: D1Database, ticker: string) {
  const info = await db.prepare('SELECT code, name, market FROM tickers WHERE code = ?').bind(ticker).first<{ code: string; name: string; market: string }>();
  const trades = (await db.prepare(`${PUBLIC_TRADES} AND o.ticker = ? ORDER BY o.trade_date DESC, o.received_ms DESC LIMIT 50`).bind(ticker).all<Record<string, unknown>>()).results;
  if (!info && trades.length === 0) return null;
  const holders = await db
    .prepare("SELECT COUNT(DISTINCT a.agent_id) AS n FROM holdings h JOIN accounts a ON a.id = h.account_id JOIN seasons s ON s.id = a.season_id WHERE s.realm = 'live' AND s.status = 'running' AND h.ticker = ?")
    .bind(ticker)
    .first<{ n: number }>();
  const last = (await lastCloses(db, [ticker], jstDate(Date.now()))).get(ticker) ?? null;
  return {
    ticker,
    name: info?.name ?? null,
    market: info?.market ?? null,
    last_close: last,
    holders: holders?.n ?? 0,
    trades,
  };
}
