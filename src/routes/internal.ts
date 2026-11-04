// 株価の取り込み（GitHub Actions から呼ぶ）。INGEST_TOKEN で認証する。
import { Hono } from 'hono';
import type { Env } from '../env';
import { missingTickers } from '../jobs/settlement';
import { ApiError, bearer, readJson, safeEqual } from '../lib/http';
import { jstIso, type Timing } from '../lib/time';

export const internalApi = new Hono<{ Bindings: Env }>();

internalApi.use('*', async (c, next) => {
  const t = bearer(c);
  if (!c.env.INGEST_TOKEN || !t || !safeEqual(t, c.env.INGEST_TOKEN)) throw new ApiError(401, 'unauthorized', 'invalid ingest token');
  await next();
});

/** 精算待ちのセッションで、まだ価格がない銘柄の一覧 */
internalApi.get('/price-requests', async (c) => {
  const sessions = (
    await c.env.DB.prepare("SELECT trade_date, timing FROM sessions WHERE realm = 'live' AND status = 'locked' ORDER BY trade_date, timing").all<{ trade_date: string; timing: Timing }>()
  ).results;
  const requests = [];
  for (const s of sessions) {
    const tickers = await missingTickers(c.env.DB, 'live', s.trade_date, s.timing);
    if (tickers.length) requests.push({ trade_date: s.trade_date, field: s.timing, tickers });
  }
  return c.json({ requests });
});

interface PriceIn {
  ticker: string;
  trade_date: string;
  field: 'open' | 'close';
  price: number | null; // null = 値が付かなかった
}

internalApi.post('/prices', async (c) => {
  const b = await readJson(c);
  const list = b.prices;
  if (!Array.isArray(list)) throw new ApiError(400, 'bad_request', 'prices must be an array');
  const now = jstIso(Date.now());
  const stmts: D1PreparedStatement[] = [];
  for (const p of list as PriceIn[]) {
    if (typeof p.ticker !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.trade_date) || (p.field !== 'open' && p.field !== 'close')) {
      throw new ApiError(400, 'bad_request', `invalid row: ${JSON.stringify(p)}`);
    }
    if (p.price !== null && !(typeof p.price === 'number' && p.price > 0)) throw new ApiError(400, 'bad_request', `invalid price: ${JSON.stringify(p)}`);
    const status = p.price === null ? 'no_trade' : 'ok';
    const col = p.field; // 'open' | 'close'（上で検証済み）
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO prices (ticker, trade_date, ${col}, ${col}_status, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (ticker, trade_date) DO UPDATE SET ${col} = excluded.${col}, ${col}_status = excluded.${col}_status, updated_at = excluded.updated_at`,
      ).bind(p.ticker, p.trade_date, p.price, status, now),
    );
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ upserted: stmts.length });
});

/** 対象銘柄の一覧を丸ごと置き換える */
internalApi.put('/tickers', async (c) => {
  const b = await readJson(c);
  const list = b.tickers;
  if (!Array.isArray(list) || list.length === 0) throw new ApiError(400, 'bad_request', 'tickers must be a non-empty array');
  const stmts: D1PreparedStatement[] = [c.env.DB.prepare('DELETE FROM tickers')];
  for (const t of list as { code: string; name: string; market: string }[]) {
    stmts.push(c.env.DB.prepare('INSERT OR REPLACE INTO tickers (code, name, market) VALUES (?, ?, ?)').bind(t.code, t.name, t.market));
  }
  await c.env.DB.batch(stmts);
  return c.json({ count: list.length });
});

/** 本番の参加中シーズンで保有されている銘柄（配当・分割の取得対象） */
internalApi.get('/held-tickers', async (c) => {
  const r = await c.env.DB.prepare(
    "SELECT DISTINCT h.ticker FROM holdings h JOIN accounts a ON a.id = h.account_id JOIN seasons s ON s.id = a.season_id WHERE s.realm = 'live' AND s.status = 'running' ORDER BY h.ticker",
  ).all<{ ticker: string }>();
  return c.json({ tickers: r.results.map((x) => x.ticker) });
});

interface QuoteIn {
  ticker: string;
  price: number;
  /** 株価の時刻（日本時間の ISO 8601。例 2026-11-04T13:20:00+09:00） */
  quoted_at: string;
}

const QUOTED_AT = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(:\d{2})?\+09:00$/;

/** 場中の株価（観戦用の暫定評価。精算には使わない）。銘柄ごとに、より新しい値だけで上書きする */
internalApi.post('/quotes', async (c) => {
  const b = await readJson(c);
  const list = b.quotes;
  if (!Array.isArray(list)) throw new ApiError(400, 'bad_request', 'quotes must be an array');
  const now = jstIso(Date.now());
  const stmts: D1PreparedStatement[] = [];
  for (const q of list as QuoteIn[]) {
    const m = typeof q.quoted_at === 'string' ? QUOTED_AT.exec(q.quoted_at) : null;
    if (typeof q.ticker !== 'string' || !/^[0-9A-Z]{4}$/.test(q.ticker) || !m || !(typeof q.price === 'number' && q.price > 0 && Number.isFinite(q.price))) {
      throw new ApiError(400, 'bad_request', `invalid quote: ${JSON.stringify(q)}`);
    }
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO live_quotes (ticker, trade_date, price, quoted_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (ticker) DO UPDATE SET trade_date = excluded.trade_date, price = excluded.price, quoted_at = excluded.quoted_at, updated_at = excluded.updated_at
         WHERE excluded.quoted_at >= live_quotes.quoted_at`,
      ).bind(q.ticker, m[1], q.price, q.quoted_at, now),
    );
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ upserted: stmts.length });
});

interface ActionIn {
  ticker: string;
  ex_date: string;
  kind: 'split' | 'dividend';
  ratio?: number;
  amount?: number;
}

/** 配当・分割の登録。反映済みのものは上書きしない */
internalApi.post('/corporate-actions', async (c) => {
  const b = await readJson(c);
  if (!Array.isArray(b.actions)) throw new ApiError(400, 'bad_request', 'actions must be an array');
  const now = jstIso(Date.now());
  const stmts: D1PreparedStatement[] = [];
  for (const a of b.actions as ActionIn[]) {
    const okSplit = a.kind === 'split' && typeof a.ratio === 'number' && a.ratio > 0 && a.ratio !== 1;
    const okDiv = a.kind === 'dividend' && typeof a.amount === 'number' && a.amount > 0;
    if (typeof a.ticker !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(a.ex_date) || !(okSplit || okDiv)) throw new ApiError(400, 'bad_request', `invalid action: ${JSON.stringify(a)}`);
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO corporate_actions (ticker, ex_date, kind, ratio, amount, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT (ticker, ex_date, kind) DO UPDATE SET ratio = excluded.ratio, amount = excluded.amount WHERE corporate_actions.status = 'pending'`,
      ).bind(a.ticker, a.ex_date, a.kind, a.kind === 'split' ? a.ratio : null, a.kind === 'dividend' ? a.amount : null, now),
    );
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ upserted: stmts.length });
});
