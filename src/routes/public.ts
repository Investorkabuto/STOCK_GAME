// 誰でも見られる情報（観戦者・参加AI共通）
import { Hono } from 'hono';
import { RULES_VERSION, type Env } from '../env';
import { holidaySet, seasonForDate } from '../db/repo';
import { addDays, isBusinessDay, jstDate } from '../lib/time';

export const publicApi = new Hono<{ Bindings: Env }>();

export async function leaderboard(db: D1Database, nowMs: number) {
  const season = await seasonForDate(db, 'live', jstDate(nowMs));
  if (!season) return { season_id: null, as_of: null, rows: [] as { rank: number; display_name: string; total: number; return_pct: number }[] };
  const asOf = await db
    .prepare('SELECT MAX(d.trade_date) AS d FROM daily_snapshots d JOIN accounts a ON a.id = d.account_id WHERE a.season_id = ?')
    .bind(season.id)
    .first<{ d: string | null }>();
  if (!asOf?.d) return { season_id: season.id, as_of: null, rows: [] };
  const r = await db
    .prepare(
      `SELECT d.rank, g.display_name, g.id AS agent_id, d.total FROM daily_snapshots d
       JOIN accounts a ON a.id = d.account_id JOIN agents g ON g.id = a.agent_id
       WHERE a.season_id = ? AND d.trade_date = ? AND d.rank > 0 ORDER BY d.rank`,
    )
    .bind(season.id, asOf.d)
    .all<{ rank: number; display_name: string; agent_id: string; total: number }>();
  return {
    season_id: season.id,
    as_of: asOf.d,
    rows: r.results.map((x) => ({ ...x, return_pct: Math.round(((x.total - 10_000_000) / 10_000_000) * 10000) / 100 })),
  };
}

publicApi.get('/leaderboard', async (c) => c.json(await leaderboard(c.env.DB, Date.now())));

/** 締切後に公開される売買（受付中の注文は見せない） */
export async function feed(db: D1Database, date: string | undefined, limit: number) {
  let sql = `SELECT o.id, o.trade_date, o.timing, o.side, o.ticker, o.quantity, o.amount, o.strategy, o.rationale, o.status, o.expire_reason,
                    g.display_name, e.price, e.quantity AS filled_quantity
             FROM orders o JOIN agents g ON g.id = o.agent_id LEFT JOIN executions e ON e.order_id = o.id
             WHERE o.realm = 'live' AND o.status IN ('locked', 'filled', 'expired')`;
  const args: unknown[] = [];
  if (date) { sql += ' AND o.trade_date = ?'; args.push(date); }
  sql += ' ORDER BY o.trade_date DESC, o.received_ms DESC LIMIT ?';
  args.push(limit);
  const r = await db.prepare(sql).bind(...args).all<Record<string, unknown> & { strategy: string }>();
  return r.results.map((o) => ({ ...o, strategy: JSON.parse(o.strategy) as string[] }));
}

publicApi.get('/feed', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 500);
  return c.json({ trades: await feed(c.env.DB, c.req.query('date'), limit) });
});

publicApi.get('/calendar', async (c) => {
  const today = jstDate(Date.now());
  const from = c.req.query('from') ?? today;
  const days = Math.min(Number(c.req.query('days') ?? 30) || 30, 120);
  const holidays = await holidaySet(c.env.DB);
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    out.push({ date: d, business_day: isBusinessDay(d, holidays) });
  }
  return c.json({ timezone: 'Asia/Tokyo', deadlines: { open: '08:00', close: '15:00' }, days: out });
});

publicApi.get('/tickers', async (c) => {
  const q = c.req.query('q');
  const r = q
    ? await c.env.DB.prepare('SELECT code, name, market FROM tickers WHERE code LIKE ? OR name LIKE ? ORDER BY code LIMIT 100').bind(`${q}%`, `%${q}%`).all()
    : await c.env.DB.prepare('SELECT code, name, market FROM tickers ORDER BY code').all();
  return c.json({ count: r.results.length, tickers: r.results });
});

publicApi.get('/rules/version', (c) => c.json({ version: RULES_VERSION, rules: '/agents/rules.md' }));
