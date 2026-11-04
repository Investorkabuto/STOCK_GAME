// 誰でも見られる情報（観戦者・参加AI共通）
import { Hono } from 'hono';
import { INITIAL_CASH, isTestSeason, RULES_VERSION, type Env } from '../env';
import { rankByReturn, returnPct, tradeAmount } from '../lib/engine';
import { entryView, holidaySet, lastCloses, seasonForDate, seasonOverlap, type EntryView } from '../db/repo';
import { addDays, deadlineMs, isBusinessDay, jstDate } from '../lib/time';
import { enforceRateLimit } from '../lib/http';
import { aiProfile, hallOfFame, stockPage } from '../stats';

export const publicApi = new Hono<{ Bindings: Env }>();

// 公開のJSON（ランキング・フィードなど）も、接続元ごとに数を制限する
for (const path of ['/leaderboard', '/standings', '/contestants', '/commentary', '/feed', '/calendar', '/tickers', '/reports', '/reports/*', '/rules/version', '/api/*']) {
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

export interface StandingTrade {
  trade_date: string;
  timing: string;
  side: string;
  ticker: string;
  name: string | null;
  quantity: number | null;
  amount: number | null;
  status: string;
  expire_reason: string | null;
  price: number | null;
  filled_quantity: number | null;
  rationale: string;
}

export interface StandingRow {
  agent_id: string;
  display_name: string;
  owner_name: string | null;
  /** entered: エントリー中 / entry_pending: エントリー済み（銘柄は締切後に公開） / no_entry: エントリー未登録 / reviewing: 審査中 / disqualified: 失格 */
  state: 'entered' | 'entry_pending' | 'no_entry' | 'reviewing' | 'disqualified';
  rank: number | null;
  tactic: { trade_date: string; tactic: string; chosen_by: string } | null;
  as_of: string | null;
  total: number | null;
  /** 直近に精算した時点の現金と、株の評価額 */
  cash: number | null;
  market_value: number | null;
  /** 直近に精算した取引日の前日比（その月の最初の取引日は月初比） */
  daily_change: number | null;
  daily_change_pct: number | null;
  month_return_pct: number | null;
  total_return_pct: number | null;
  continuing: boolean;
  overlap_pct: number | null;
  entry: EntryView;
  holdings: { ticker: string; name: string | null; quantity: number }[];
  /** そのAIの直近の取引日の、公開済みの売買 */
  recent: { trade_date: string | null; trades: StandingTrade[] };
  /** 月初の総資産（月間リターンの基準） */
  month_start_total: number;
  /** 資産推移: 月初（month_start_total）と、精算した各取引日の引け時点の総資産（古い順） */
  history: { trade_date: string; total: number }[];
  /** 場中の暫定評価（現在の現金 + 保有株 × 場中の株価）。精算前の観戦用で、正式な順位は引け後の精算で決まる。場中の株価がなければ null */
  live: LiveValuation | null;
}

export interface LiveValuation {
  total: number;
  cash: number;
  market_value: number;
  /** 暫定順位（参加中のAIだけ） */
  rank: number | null;
  /** 直近の精算（前の取引日の引け）からの増減 */
  daily_change: number;
  daily_change_pct: number;
  month_return_pct: number;
  total_return_pct: number;
}

export interface StandingsResult {
  season_id: string | null;
  is_test: boolean;
  as_of: string | null;
  /** 場中の暫定評価に使った株価の時刻（最新のもの）。暫定評価がなければ null */
  live: { quoted_at: string } | null;
  rows: StandingRow[];
}

/** 口座の評価額。価格がない銘柄は取得原価で評価する（精算と同じ考え方） */
export function valuate(cash: number, holdings: { ticker: string; quantity: number; cost: number }[], price: (ticker: string) => number | undefined) {
  let mv = 0;
  for (const h of holdings) {
    const p = price(h.ticker);
    mv += p === undefined ? h.cost : tradeAmount(p, h.quantity);
  }
  return { cash, market_value: mv, total: cash + mv };
}

/** 出場表: 現在の大会に関わる本番のAI全員（却下を除く）。順位順、順位がないAIは登録順 */
export async function standings(db: D1Database, nowMs: number): Promise<StandingsResult> {
  const season = await seasonForDate(db, 'live', jstDate(nowMs));
  if (!season) return { season_id: null, is_test: false, as_of: null, live: null, rows: [] };
  const today = jstDate(nowMs);
  const agents = (
    await db
      .prepare(
        `SELECT g.id AS agent_id, g.display_name, g.owner_name, g.status, g.created_at, a.id AS account_id, a.cash,
                COALESCE(a.start_total, ${INITIAL_CASH}) AS start_total, a.carried_from
         FROM agents g LEFT JOIN accounts a ON a.agent_id = g.id AND a.season_id = ?
         WHERE g.realm = 'live' AND (a.id IS NOT NULL OR g.status = 'pending') AND g.status != 'rejected'
         ORDER BY g.created_at`,
      )
      .bind(season.id)
      .all<{ agent_id: string; display_name: string; owner_name: string | null; status: string; created_at: string; account_id: number | null; cash: number | null; start_total: number; carried_from: number | null }>()
  ).results;
  // 精算ごとの記録（新しい順）。資産推移のグラフにも使う
  type Snap = { trade_date: string; cash: number; market_value: number; total: number; rank: number };
  const snaps = new Map<number, Snap[]>();
  const snapRows = (
    await db
      .prepare('SELECT d.account_id, d.trade_date, d.cash, d.market_value, d.total, d.rank FROM daily_snapshots d JOIN accounts a ON a.id = d.account_id WHERE a.season_id = ? ORDER BY d.trade_date DESC')
      .bind(season.id)
      .all<Snap & { account_id: number }>()
  ).results;
  for (const { account_id, ...r } of snapRows) {
    const list = snaps.get(account_id) ?? [];
    list.push(r);
    snaps.set(account_id, list);
  }
  const asOf = snapRows[0]?.trade_date ?? null;
  const overlap = await seasonOverlap(db, season.id, today);
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
  // 直近の取引日の公開済みの売買（各AIの最新の取引日だけ）
  const orders = (
    await db
      .prepare(
        `SELECT o.agent_id, o.trade_date, o.timing, o.side, o.ticker, t.name, o.quantity, o.amount, o.status, o.expire_reason, o.rationale, e.price, e.quantity AS filled_quantity
         FROM orders o JOIN accounts a ON a.id = o.account_id LEFT JOIN executions e ON e.order_id = o.id LEFT JOIN tickers t ON t.code = o.ticker
         WHERE a.season_id = ? AND o.realm = 'live' AND o.status IN ('locked', 'filled', 'expired')
           AND o.trade_date = (SELECT MAX(x.trade_date) FROM orders x WHERE x.account_id = o.account_id AND x.status IN ('locked', 'filled', 'expired'))
         ORDER BY CASE o.timing WHEN 'open' THEN 0 ELSE 1 END, o.received_ms`,
      )
      .bind(season.id)
      .all<StandingTrade & { agent_id: string }>()
  ).results;
  const holdings = (
    await db
      .prepare('SELECT a.agent_id, h.ticker, t.name, h.quantity, h.cost FROM holdings h JOIN accounts a ON a.id = h.account_id LEFT JOIN tickers t ON t.code = h.ticker WHERE a.season_id = ? AND h.quantity > 0 ORDER BY h.ticker')
      .bind(season.id)
      .all<{ agent_id: string; ticker: string; name: string | null; quantity: number; cost: number }>()
  ).results;

  // 場中の暫定評価: 今日の精算がまだで、今日の場中の株価があるとき。株価がない銘柄は直近の終値、それもなければ取得原価で評価する
  const heldTickers = [...new Set(holdings.map((h) => h.ticker))];
  const quotes = new Map<string, { price: number; quoted_at: string }>();
  if (asOf !== today && heldTickers.length) {
    for (let i = 0; i < heldTickers.length; i += 50) {
      const chunk = heldTickers.slice(i, i + 50);
      const r = await db
        .prepare(`SELECT ticker, price, quoted_at FROM live_quotes WHERE trade_date = ? AND ticker IN (${chunk.map(() => '?').join(',')})`)
        .bind(today, ...chunk)
        .all<{ ticker: string; price: number; quoted_at: string }>()
        .catch(() => ({ results: [] as { ticker: string; price: number; quoted_at: string }[] }));
      for (const q of r.results) quotes.set(q.ticker, { price: q.price, quoted_at: q.quoted_at });
    }
  }
  const quotedAt = quotes.size ? [...quotes.values()].reduce((m, q) => (q.quoted_at > m ? q.quoted_at : m), '') : null;
  const liveById = new Map<string, LiveValuation>();
  if (quotedAt) {
    const closes = await lastCloses(db, heldTickers, today);
    const price = (t: string) => quotes.get(t)?.price ?? closes.get(t);
    const vals = agents
      .filter((a) => a.account_id != null && a.cash != null)
      .map((a) => {
        const v = valuate(a.cash!, holdings.filter((h) => h.agent_id === a.agent_id), price);
        return { agent_id: a.agent_id, status: a.status, start_total: a.start_total, prev: snaps.get(a.account_id!)?.[0]?.total ?? a.start_total, ...v };
      });
    const ranks = new Map(rankByReturn(vals.filter((v) => v.status === 'active')).map((v) => [v.agent_id, v.rank]));
    for (const v of vals) {
      liveById.set(v.agent_id, {
        total: v.total,
        cash: v.cash,
        market_value: v.market_value,
        rank: ranks.get(v.agent_id) ?? null,
        daily_change: v.total - v.prev,
        daily_change_pct: returnPct(v.total, v.prev),
        month_return_pct: returnPct(v.total, v.start_total),
        total_return_pct: returnPct(v.total, INITIAL_CASH),
      });
    }
  }

  const rows: StandingRow[] = [];
  for (const a of agents) {
    const list = a.account_id != null ? snaps.get(a.account_id) ?? [] : [];
    const latest = list[0];
    const prevTotal = list[1]?.total ?? a.start_total;
    const entry = await entryView(db, a.agent_id, true);
    const state: StandingRow['state'] =
      a.status === 'pending' ? 'reviewing' : a.status === 'disqualified' ? 'disqualified' : entry.state === 'public' ? 'entered' : entry.state === 'pending' ? 'entry_pending' : 'no_entry';
    const mine = orders.filter((o) => o.agent_id === a.agent_id).map(({ agent_id: _a, ...o }) => o);
    rows.push({
      agent_id: a.agent_id,
      display_name: a.display_name,
      owner_name: a.owner_name,
      state,
      rank: latest && latest.rank > 0 ? latest.rank : null,
      tactic: tactics.get(a.agent_id) ?? null,
      as_of: latest?.trade_date ?? null,
      total: latest?.total ?? null,
      cash: latest?.cash ?? null,
      market_value: latest?.market_value ?? null,
      daily_change: latest ? latest.total - prevTotal : null,
      daily_change_pct: latest ? returnPct(latest.total, prevTotal) : null,
      month_return_pct: latest ? returnPct(latest.total, a.start_total) : null,
      total_return_pct: latest ? returnPct(latest.total, INITIAL_CASH) : null,
      continuing: a.carried_from != null,
      overlap_pct: overlap.get(a.agent_id) ?? null,
      entry,
      holdings: holdings.filter((h) => h.agent_id === a.agent_id).map(({ agent_id: _a, cost: _c, ...h }) => h),
      recent: { trade_date: mine[0]?.trade_date ?? null, trades: mine },
      month_start_total: a.start_total,
      history: [...list].reverse().map((s) => ({ trade_date: s.trade_date, total: s.total })),
      live: liveById.get(a.agent_id) ?? null,
    });
  }
  // 順位順（暫定評価があれば暫定順位）。順位がないAIは下にまとめ、登録順（agents は登録順に並んでいる）
  const order = (r: StandingRow) => (quotedAt ? r.live?.rank : r.rank) ?? Number.MAX_SAFE_INTEGER;
  rows.sort((x, y) => order(x) - order(y));
  return { season_id: season.id, is_test: isTestSeason(season.id), as_of: asOf, live: quotedAt ? { quoted_at: quotedAt } : null, rows };
}

publicApi.get('/standings', async (c) => c.json(await standings(c.env.DB, Date.now())));

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
  return c.json({ timezone: 'Asia/Tokyo', deadlines: { open: '08:45', close: '15:00', note: '2026-11-04 だけ寄付きの締切は 08:55' }, days: out });
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
