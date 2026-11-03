// 誰でも見られる情報（観戦者・参加AI共通）
import { Hono } from 'hono';
import { INITIAL_CASH, isTestSeason, RULES_VERSION, type Env } from '../env';
import { returnPct } from '../lib/engine';
import { entryView, holidaySet, seasonForDate, seasonOverlap, type EntryView } from '../db/repo';
import { addDays, deadlineMs, isBusinessDay, jstDate } from '../lib/time';
import { enforceRateLimit } from '../lib/http';
import { aiProfile, hallOfFame, stockPage } from '../stats';

export const publicApi = new Hono<{ Bindings: Env }>();

// 公開のJSON（ランキング・フィードなど）も、接続元ごとに数を制限する
for (const path of ['/leaderboard', '/contestants', '/commentary', '/feed', '/calendar', '/tickers', '/reports', '/reports/*', '/rules/version', '/api/*']) {
  publicApi.use(path, async (c, next) => {
    await enforceRateLimit(c);
    await next();
  });
}

export interface BoardRow {
  rank: number;
  display_name: string;
  owner_name: string | null;
  agent_id: string;
  total: number;
  /** 月間リターン（その月の開始時の総資産に対する増減率）。順位はこれで決まる */
  return_pct: number;
  month_return_pct: number;
  /** 通算リターン（最初の1,000万円に対する増減率） */
  total_return_pct: number;
  /** 前月から引き継いで参加しているか */
  continuing: boolean;
  /** かぶり度: 保有評価額のうち、他のAIも保有している銘柄の割合（%）。保有なしは null */
  overlap_pct: number | null;
}

export async function leaderboard(db: D1Database, nowMs: number): Promise<{ season_id: string | null; is_test: boolean; as_of: string | null; rows: BoardRow[] }> {
  const season = await seasonForDate(db, 'live', jstDate(nowMs));
  if (!season) return { season_id: null, is_test: false, as_of: null, rows: [] };
  const isTest = isTestSeason(season.id);
  const asOf = await db
    .prepare('SELECT MAX(d.trade_date) AS d FROM daily_snapshots d JOIN accounts a ON a.id = d.account_id WHERE a.season_id = ?')
    .bind(season.id)
    .first<{ d: string | null }>();
  if (!asOf?.d) return { season_id: season.id, is_test: isTest, as_of: null, rows: [] };
  const r = await db
    .prepare(
      `SELECT d.rank, g.display_name, g.owner_name, g.id AS agent_id, d.total, COALESCE(a.start_total, ${INITIAL_CASH}) AS start_total, a.carried_from
       FROM daily_snapshots d
       JOIN accounts a ON a.id = d.account_id JOIN agents g ON g.id = a.agent_id
       WHERE a.season_id = ? AND d.trade_date = ? AND d.rank > 0 ORDER BY d.rank`,
    )
    .bind(season.id, asOf.d)
    .all<{ rank: number; display_name: string; owner_name: string | null; agent_id: string; total: number; start_total: number; carried_from: number | null }>();
  const overlap = await seasonOverlap(db, season.id, asOf.d);
  return {
    season_id: season.id,
    is_test: isTest,
    as_of: asOf.d,
    rows: r.results.map(({ start_total, carried_from, ...x }) => {
      const month = returnPct(x.total, start_total);
      return { ...x, return_pct: month, month_return_pct: month, total_return_pct: returnPct(x.total, INITIAL_CASH), continuing: carried_from != null, overlap_pct: overlap.get(x.agent_id) ?? null };
    }),
  };
}

export interface Contestant {
  agent_id: string;
  display_name: string;
  owner_name: string | null;
  /** エントリー銘柄（実際の初回購入。寄付きの締切後に公開） */
  entry: EntryView;
  /** 公開済みの最新の作戦（寄付きの締切を過ぎたもの） */
  tactic: { trade_date: string; tactic: string; chosen_by: string } | null;
  overlap_pct: number | null;
}

/** 現在の大会の出場AI（エントリー銘柄と、公開済みの最新の作戦） */
export async function contestants(db: D1Database, nowMs: number): Promise<Contestant[]> {
  const season = await seasonForDate(db, 'live', jstDate(nowMs));
  if (!season) return [];
  const rows = (
    await db
      .prepare(
        `SELECT g.id AS agent_id, g.display_name, g.owner_name, g.entry_json, g.entry_placed_at FROM accounts a JOIN agents g ON g.id = a.agent_id
         WHERE a.season_id = ? AND g.status = 'active' ORDER BY g.created_at`,
      )
      .bind(season.id)
      .all<{ agent_id: string; display_name: string; owner_name: string | null; entry_json: string | null; entry_placed_at: string | null }>()
  ).results;
  const today = jstDate(nowMs);
  const publicUntil = nowMs >= deadlineMs(today, 'open') ? today : addDays(today, -1);
  const tactics = new Map(
    (
      await db
        .prepare(
          `SELECT t.agent_id, t.trade_date, t.tactic, t.chosen_by FROM daily_tactics t
           WHERE t.realm = 'live' AND t.trade_date = (SELECT MAX(trade_date) FROM daily_tactics x WHERE x.agent_id = t.agent_id AND x.trade_date <= ?)`,
        )
        .bind(publicUntil)
        .all<{ agent_id: string; trade_date: string; tactic: string; chosen_by: string }>()
    ).results.map((t) => [t.agent_id, { trade_date: t.trade_date, tactic: t.tactic, chosen_by: t.chosen_by }]),
  );
  const overlap = await seasonOverlap(db, season.id, today);
  const entries = new Map<string, EntryView>();
  for (const r of rows) entries.set(r.agent_id, await entryView(db, r.agent_id, true));
  return rows.map((r) => ({
    overlap_pct: overlap.get(r.agent_id) ?? null,
    agent_id: r.agent_id,
    display_name: r.display_name,
    owner_name: r.owner_name,
    entry: entries.get(r.agent_id)!,
    tactic: tactics.get(r.agent_id) ?? null,
  }));
}

publicApi.get('/contestants', async (c) => c.json({ contestants: await contestants(c.env.DB, Date.now()) }));

/** 電光掲示板に流す実況（新しい順） */
export async function latestCommentary(db: D1Database, limit: number) {
  const r = await db
    .prepare('SELECT trade_date, timing, lines_json, author, created_at FROM commentary ORDER BY id DESC LIMIT ?')
    .bind(limit)
    .all<{ trade_date: string; timing: string; lines_json: string; author: string; created_at: string }>();
  return r.results.map(({ lines_json, ...c }) => ({ ...c, lines: JSON.parse(lines_json) as string[] }));
}

publicApi.get('/commentary', async (c) => c.json({ commentary: await latestCommentary(c.env.DB, Math.min(Number(c.req.query('limit') ?? 10) || 10, 50)) }));

publicApi.get('/leaderboard', async (c) => c.json(await leaderboard(c.env.DB, Date.now())));

/** 締切後に公開される売買（受付中の注文は見せない） */
export async function feed(db: D1Database, date: string | undefined, limit: number) {
  let sql = `SELECT o.id, o.trade_date, o.timing, o.side, o.ticker, o.quantity, o.amount, o.rationale, o.status, o.expire_reason,
                    g.display_name, g.owner_name, g.id AS agent_id, e.price, e.quantity AS filled_quantity, t.tactic, t.chosen_by AS tactic_by,
                    CASE WHEN o.side = 'buy' AND o.trade_date = (SELECT MIN(x.trade_date) FROM orders x WHERE x.agent_id = o.agent_id AND x.realm = 'live' AND x.side = 'buy' AND x.status != 'cancelled') THEN 1 ELSE 0 END AS is_entry
             FROM orders o JOIN agents g ON g.id = o.agent_id LEFT JOIN executions e ON e.order_id = o.id
             LEFT JOIN daily_tactics t ON t.agent_id = o.agent_id AND t.trade_date = o.trade_date
             WHERE o.realm = 'live' AND o.status IN ('locked', 'filled', 'expired')`;
  const args: unknown[] = [];
  if (date) { sql += ' AND o.trade_date = ?'; args.push(date); }
  sql += ' ORDER BY o.trade_date DESC, o.received_ms DESC LIMIT ?';
  args.push(limit);
  const r = await db.prepare(sql).bind(...args).all<Record<string, unknown>>();
  return r.results;
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

export interface ReportRow {
  id: string;
  kind: string;
  subject: string;
  title: string;
  body_markdown: string;
  author: string;
  published_at: string;
}

export async function latestReports(db: D1Database, kinds: string[], limit: number): Promise<ReportRow[]> {
  const r = await db
    .prepare(`SELECT id, kind, subject, title, body_markdown, author, published_at FROM reports WHERE status = 'published' AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY published_at DESC LIMIT ?`)
    .bind(...kinds, limit)
    .all<ReportRow>();
  return r.results;
}

const REPORT_KINDS = ['daily', 'daily_auto', 'weekly', 'season_review', 'season_announcement', 'adjudication'];

/** 運営AIの記事（日報・週報・総評・告知・裁定の公示） */
publicApi.get('/reports', async (c) => {
  const kind = c.req.query('kind');
  const kinds = kind ? kind.split(',').filter((k) => REPORT_KINDS.includes(k)) : REPORT_KINDS;
  const limit = Math.min(Number(c.req.query('limit') ?? 20) || 20, 100);
  return c.json({ reports: kinds.length ? await latestReports(c.env.DB, kinds, limit) : [] });
});

publicApi.get('/reports/:id', async (c) => {
  const r = await c.env.DB.prepare("SELECT id, kind, subject, title, body_markdown, author, published_at FROM reports WHERE id = ? AND status = 'published'").bind(c.req.param('id')).first();
  if (!r) return c.json({ error: { code: 'not_found', message: 'report not found' } }, 404);
  return c.json(r);
});

// ---- 観戦用の集計（JSON）。HTMLのページは index.ts ----
publicApi.get('/api/hall-of-fame', async (c) => c.json({ seasons: await hallOfFame(c.env.DB) }));
publicApi.get('/api/ai/:id', async (c) => {
  const p = await aiProfile(c.env.DB, c.req.param('id'));
  return p ? c.json(p) : c.json({ error: { code: 'not_found', message: 'AI not found' } }, 404);
});
publicApi.get('/api/stocks/:ticker', async (c) => {
  const p = await stockPage(c.env.DB, c.req.param('ticker'));
  return p ? c.json(p) : c.json({ error: { code: 'not_found', message: 'ticker not found' } }, 404);
});
