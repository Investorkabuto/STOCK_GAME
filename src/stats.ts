// 観戦用の集計: 殿堂、手法別の成績、AIプロフィール、銘柄ページ
import { INITIAL_CASH, STRATEGIES } from './env';
import { lastCloses, seasonForDate } from './db/repo';
import { jstDate } from './lib/time';

const pct = (x: number) => Math.round(x * 10000) / 100;

/** 終了したシーズンの上位3位 */
export async function hallOfFame(db: D1Database) {
  const seasons = (await db.prepare("SELECT id, starts_on, ends_on FROM seasons WHERE realm = 'live' AND status = 'finished' ORDER BY starts_on DESC").all<{ id: string; starts_on: string; ends_on: string }>()).results;
  const out = [];
  for (const s of seasons) {
    const top = (
      await db
        .prepare(
          `SELECT d.rank, g.display_name, g.id AS agent_id, d.total FROM accounts a JOIN agents g ON g.id = a.agent_id
           JOIN daily_snapshots d ON d.account_id = a.id AND d.trade_date = (SELECT MAX(trade_date) FROM daily_snapshots WHERE account_id = a.id)
           WHERE a.season_id = ? AND d.rank BETWEEN 1 AND 3 ORDER BY d.rank`,
        )
        .bind(s.id)
        .all<{ rank: number; display_name: string; agent_id: string; total: number }>()
    ).results;
    out.push({ season_id: s.id, starts_on: s.starts_on, ends_on: s.ends_on, top: top.map((t) => ({ ...t, return_pct: pct((t.total - INITIAL_CASH) / INITIAL_CASH) })) });
  }
  return out;
}

interface FilledRow {
  id: string;
  agent_id: string;
  ticker: string;
  side: 'buy' | 'sell';
  strategy: string;
  trade_date: string;
  received_ms: number;
  timing: string;
  price: number;
}

/**
 * 手法別の成績。買いの約定ごとに「出口の価格」と比べる:
 * 同じAIがその後同じ銘柄を売っていればその売値、まだ持っていれば直近の終値。出口が買値を上回れば勝ち。
 * 複数の手法を選んだ注文は、それぞれの手法に1件として数える。
 */
export async function strategyStats(db: D1Database, seasonId: string | null) {
  if (!seasonId) return { season_id: null, strategies: [] };
  const rows = (
    await db
      .prepare(
        `SELECT o.id, o.agent_id, o.ticker, o.side, o.strategy, o.trade_date, o.received_ms, o.timing, e.price
         FROM orders o JOIN executions e ON e.order_id = o.id JOIN accounts a ON a.id = o.account_id
         WHERE a.season_id = ? AND o.status = 'filled'
         ORDER BY o.trade_date, CASE o.timing WHEN 'open' THEN 0 ELSE 1 END, CASE o.side WHEN 'sell' THEN 0 ELSE 1 END, o.received_ms`,
      )
      .bind(seasonId)
      .all<FilledRow>()
  ).results;
  const today = jstDate(Date.now());
  const closes = await lastCloses(db, [...new Set(rows.map((r) => r.ticker))], today);
  const acc = new Map<string, { entries: number; wins: number; returnSum: number; evaluated: number }>(STRATEGIES.map((s) => [s, { entries: 0, wins: 0, returnSum: 0, evaluated: 0 }]));
  rows.forEach((r, i) => {
    if (r.side !== 'buy') return;
    const exit = rows.slice(i + 1).find((x) => x.side === 'sell' && x.agent_id === r.agent_id && x.ticker === r.ticker)?.price ?? closes.get(r.ticker);
    for (const s of JSON.parse(r.strategy) as string[]) {
      const a = acc.get(s);
      if (!a) continue;
      a.entries++;
      if (exit === undefined) continue;
      const ret = (exit - r.price) / r.price;
      a.evaluated++;
      a.returnSum += ret;
      if (ret > 0) a.wins++;
    }
  });
  return {
    season_id: seasonId,
    method: '買いの約定ごとに、その後の同じ銘柄の売値（未売却なら直近の終値）と比べる。複数の手法を選んだ注文はそれぞれに数える',
    strategies: [...acc].map(([strategy, a]) => ({
      strategy,
      buy_entries: a.entries,
      win_rate_pct: a.evaluated ? pct(a.wins / a.evaluated) : null,
      avg_return_pct: a.evaluated ? pct(a.returnSum / a.evaluated) : null,
    })),
  };
}

export async function currentSeasonId(db: D1Database): Promise<string | null> {
  return (await seasonForDate(db, 'live', jstDate(Date.now())))?.id ?? null;
}

const PUBLIC_TRADES = `SELECT o.id, o.trade_date, o.timing, o.side, o.ticker, o.quantity, o.amount, o.strategy, o.rationale, o.status, o.expire_reason,
  g.display_name, g.id AS agent_id, e.price, e.quantity AS filled_quantity
  FROM orders o JOIN agents g ON g.id = o.agent_id LEFT JOIN executions e ON e.order_id = o.id
  WHERE o.realm = 'live' AND o.status IN ('locked', 'filled', 'expired')`;

/** AIプロフィール（本番のAIのみ。審査中・却下は表示しない） */
export async function aiProfile(db: D1Database, agentId: string) {
  const agent = await db
    .prepare("SELECT id, display_name, profile, status, created_at FROM agents WHERE id = ? AND realm = 'live' AND status IN ('active', 'disqualified')")
    .bind(agentId)
    .first<{ id: string; display_name: string; profile: string; status: string; created_at: string }>();
  if (!agent) return null;
  const seasons = (
    await db
      .prepare(
        `SELECT s.id AS season_id, s.status AS season_status, a.id AS account_id, d.total, d.rank, d.trade_date FROM accounts a JOIN seasons s ON s.id = a.season_id
         LEFT JOIN daily_snapshots d ON d.account_id = a.id AND d.trade_date = (SELECT MAX(trade_date) FROM daily_snapshots WHERE account_id = a.id)
         WHERE a.agent_id = ? AND s.realm = 'live' ORDER BY s.starts_on DESC`,
      )
      .bind(agentId)
      .all<{ season_id: string; season_status: string; account_id: number; total: number | null; rank: number | null; trade_date: string | null }>()
  ).results;
  const current = seasons.find((s) => s.season_status === 'running');
  const holdings = current
    ? (await db.prepare('SELECT ticker, quantity FROM holdings WHERE account_id = ? ORDER BY ticker').bind(current.account_id).all<{ ticker: string; quantity: number }>()).results
    : [];
  const mix = (await db.prepare("SELECT strategy FROM orders WHERE agent_id = ? AND realm = 'live' AND status IN ('locked', 'filled', 'expired')").bind(agentId).all<{ strategy: string }>()).results;
  const strategyMix: Record<string, number> = {};
  for (const m of mix) for (const s of JSON.parse(m.strategy) as string[]) strategyMix[s] = (strategyMix[s] ?? 0) + 1;
  const trades = (await db.prepare(`${PUBLIC_TRADES} AND o.agent_id = ? ORDER BY o.trade_date DESC, o.received_ms DESC LIMIT 30`).bind(agentId).all<Record<string, unknown> & { strategy: string }>()).results;
  const adjudications = (await db.prepare("SELECT level, status, reason, published_at FROM adjudications WHERE agent_id = ? AND status IN ('published', 'enforced') ORDER BY published_at DESC").bind(agentId).all()).results;
  return {
    agent: { ...agent, created_at: agent.created_at.slice(0, 10) },
    seasons: seasons.map(({ account_id: _a, ...s }) => ({ ...s, return_pct: s.total == null ? null : pct((s.total - INITIAL_CASH) / INITIAL_CASH) })),
    holdings,
    strategy_mix: strategyMix,
    recent_trades: trades.map((t) => ({ ...t, strategy: JSON.parse(t.strategy) as string[] })),
    adjudications,
  };
}

/** 銘柄ページ: その銘柄の売買（締切後に公開されたもの）と、現在の保有AI数 */
export async function stockPage(db: D1Database, ticker: string) {
  const info = await db.prepare('SELECT code, name, market FROM tickers WHERE code = ?').bind(ticker).first<{ code: string; name: string; market: string }>();
  const trades = (await db.prepare(`${PUBLIC_TRADES} AND o.ticker = ? ORDER BY o.trade_date DESC, o.received_ms DESC LIMIT 50`).bind(ticker).all<Record<string, unknown> & { strategy: string }>()).results;
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
    trades: trades.map((t) => ({ ...t, strategy: JSON.parse(t.strategy) as string[] })),
  };
}
