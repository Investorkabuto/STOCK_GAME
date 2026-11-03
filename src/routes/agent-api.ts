// 参加AI向けAPI。本番（/）とサンドボックス（/sandbox）で同じ実装を使う。
import { Hono, type Context } from 'hono';
import { challengeTtlMs, INITIAL_CASH, SANDBOX_SEASON_ID, STRATEGIES, type Env, type Realm } from '../env';
import { eventStatement, formatOrder, holidaySet, lastCloses, loadAccount, seasonForDate, type AgentRow, type OrderRow } from '../db/repo';
import { challengeAnswer, generateChallenge } from '../lib/challenge';
import { newId, randInt, randomToken, sha256Hex } from '../lib/crypto';
import { marketValue } from '../lib/engine';
import { ApiError, bearer, readJson } from '../lib/http';
import { deadlineMs, jstIso, nextEligibleTradeDate, type Timing } from '../lib/time';
import { settleSandbox } from '../jobs/settlement';

type Vars = { agent: AgentRow; now: number };
type AppEnv = { Bindings: Env; Variables: Vars };

const TICKER_RE = /^[0-9][0-9A-Z]{3}$/;

// ---- チャレンジ ----

async function issueChallenge(db: D1Database, nowMs: number) {
  const spec = generateChallenge(randInt);
  const nonce = randomToken(16);
  await db
    .prepare('INSERT INTO challenges (nonce, answer, issued_ms) VALUES (?, ?, ?)')
    .bind(nonce, await challengeAnswer(spec.preimage, nonce), nowMs)
    .run();
  return { nonce, prompt: spec.prompt };
}

async function verifyChallenge(c: Context<AppEnv>, body: Record<string, unknown>) {
  const ch = body.challenge as { nonce?: unknown; answer?: unknown } | undefined;
  if (!ch || typeof ch.nonce !== 'string' || typeof ch.answer !== 'string') {
    throw new ApiError(400, 'challenge_required', 'challenge.nonce と challenge.answer が必要です。先に GET /challenge で課題を取得してください');
  }
  const now = c.get('now');
  const row = await c.env.DB.prepare('SELECT answer, issued_ms, used FROM challenges WHERE nonce = ?').bind(ch.nonce).first<{ answer: string; issued_ms: number; used: number }>();
  if (!row || row.used) throw new ApiError(400, 'challenge_invalid', 'nonce が無効か、使用済みです');
  const elapsed = now - row.issued_ms;
  const ttl = challengeTtlMs(c.env);
  // 使い捨て: 判定の前に使用済みにする（同時送信による再利用を防ぐ）
  const mark = await c.env.DB.prepare('UPDATE challenges SET used = 1 WHERE nonce = ? AND used = 0').bind(ch.nonce).run();
  if (mark.meta.changes !== 1) throw new ApiError(400, 'challenge_invalid', 'nonce が無効か、使用済みです');
  if (elapsed > ttl) throw new ApiError(400, 'challenge_expired', `制限時間（${ttl}ms）を過ぎています`, { elapsed_ms: elapsed, limit_ms: ttl });
  if (ch.answer.toLowerCase() !== row.answer) throw new ApiError(400, 'challenge_wrong', '答えが正しくありません');
}

// ---- 注文の検証 ----

interface OrderInput {
  side: 'buy' | 'sell';
  timing: Timing;
  ticker: string;
  quantity: number | null;
  amount: number | null;
  strategy: string[];
  rationale: string;
}

async function validateOrder(db: D1Database, b: Record<string, unknown>, partialFrom?: OrderRow): Promise<OrderInput> {
  const errors: string[] = [];
  const pick = <T>(k: string, fallback: T | undefined): unknown => (k in b ? b[k] : fallback);
  const side = pick('side', partialFrom?.side);
  const timing = pick('timing', partialFrom?.timing);
  const ticker = pick('ticker', partialFrom?.ticker);
  let quantity = pick('quantity', partialFrom?.quantity) ?? null;
  let amount = pick('amount', partialFrom?.amount) ?? null;
  // 修正で片方だけ指定された場合は、もう片方を消す
  if (partialFrom && 'quantity' in b && b.quantity != null && !('amount' in b)) amount = null;
  if (partialFrom && 'amount' in b && b.amount != null && !('quantity' in b)) quantity = null;
  const strategy = pick('strategy', partialFrom ? JSON.parse(partialFrom.strategy) : undefined);
  const rationale = pick('rationale', partialFrom?.rationale);

  if (side !== 'buy' && side !== 'sell') errors.push('side は "buy" か "sell"');
  if (timing !== 'open' && timing !== 'close') errors.push('timing は "open"（寄付き）か "close"（引け）');
  if (typeof ticker !== 'string' || !TICKER_RE.test(ticker)) errors.push('ticker は4桁の銘柄コード（例: "7203"、"130A"）');
  if ((quantity === null) === (amount === null)) errors.push('quantity（株数）と amount（金額）のどちらか一方だけを指定');
  if (quantity !== null && !(Number.isInteger(quantity) && (quantity as number) > 0 && (quantity as number) % 100 === 0)) errors.push('quantity は100株単位の正の整数');
  if (amount !== null && !(Number.isInteger(amount) && (amount as number) > 0)) errors.push('amount は正の整数（円）');
  if (amount !== null && side === 'sell') errors.push('金額指定（amount）は買い注文だけで使える');
  if (!Array.isArray(strategy) || strategy.length === 0 || !strategy.every((s) => (STRATEGIES as readonly string[]).includes(s))) {
    errors.push(`strategy は ${STRATEGIES.join(' / ')} から1つ以上を選んだ配列`);
  }
  if (typeof rationale !== 'string' || rationale.trim().length === 0 || rationale.length > 2000) errors.push('rationale は1〜2000文字の判断根拠');
  if (errors.length) throw new ApiError(400, 'validation_failed', '注文の内容に誤りがあります', errors);

  const listed = await db.prepare('SELECT COUNT(*) AS n FROM tickers').first<{ n: number }>();
  if ((listed?.n ?? 0) > 0) {
    const t = await db.prepare('SELECT code FROM tickers WHERE code = ?').bind(ticker).first();
    if (!t) throw new ApiError(400, 'unknown_ticker', `銘柄 ${ticker as string} は対象外です。GET /tickers で対象銘柄を確認してください`);
  }
  return {
    side: side as 'buy' | 'sell',
    timing: timing as Timing,
    ticker: ticker as string,
    quantity: quantity as number | null,
    amount: amount as number | null,
    strategy: strategy as string[],
    rationale: (rationale as string).trim(),
  };
}

async function accountFor(db: D1Database, realm: Realm, agentId: string, tradeDate: string): Promise<number> {
  if (realm === 'sandbox') {
    const a = await db.prepare('SELECT id FROM accounts WHERE season_id = ? AND agent_id = ?').bind(SANDBOX_SEASON_ID, agentId).first<{ id: number }>();
    if (!a) throw new ApiError(500, 'internal', 'サンドボックス口座がありません');
    return a.id;
  }
  const season = await seasonForDate(db, 'live', tradeDate);
  const a = season
    ? await db.prepare('SELECT id FROM accounts WHERE season_id = ? AND agent_id = ?').bind(season.id, agentId).first<{ id: number }>()
    : null;
  if (!a) {
    throw new ApiError(409, 'no_account', `取引日 ${tradeDate} のシーズンに参加していません。シーズンは毎月1日に始まり、登録締切（開始日の2日前 23:59）までに申請・承認されたAIだけが参加できます`);
  }
  return a.id;
}

export function agentApi(realm: Realm) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('now', Date.now());
    await next();
  });

  const auth = (opts: { activeOnly: boolean }) => async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const token = bearer(c);
    if (!token) throw new ApiError(401, 'unauthorized', 'Authorization: Bearer <APIキー> が必要です');
    const agent = await c.env.DB.prepare('SELECT * FROM agents WHERE api_key_hash = ?').bind(await sha256Hex(token)).first<AgentRow>();
    if (!agent) throw new ApiError(401, 'unauthorized', 'APIキーが無効です');
    if (agent.realm !== realm) {
      throw new ApiError(403, 'wrong_realm', realm === 'sandbox' ? '本番のAPIキーはサンドボックスで使えません' : 'サンドボックスのAPIキーは本番で使えません');
    }
    if (opts.activeOnly && agent.status !== 'active') {
      throw new ApiError(403, 'agent_not_active', `このAIは注文できない状態です（status: ${agent.status}）。GET /agents/me で状態を確認してください`);
    }
    c.set('agent', agent);
    await next();
  };
  const anyAgent = auth({ activeOnly: false });
  const activeAgent = auth({ activeOnly: true });

  app.get('/challenge', async (c) => {
    const ch = await issueChallenge(c.env.DB, c.get('now'));
    return c.json({ ...ch, expires_in_ms: challengeTtlMs(c.env) });
  });

  // ---- 登録 ----
  app.post('/agents', async (c) => {
    const b = await readJson(c);
    await verifyChallenge(c, b);
    const name = typeof b.display_name === 'string' ? b.display_name.trim() : '';
    const profile = typeof b.profile === 'string' ? b.profile.trim() : '';
    if (name.length < 1 || name.length > 40) throw new ApiError(400, 'validation_failed', 'display_name は1〜40文字');
    if (profile.length > 1000) throw new ApiError(400, 'validation_failed', 'profile は1000文字まで');
    if (b.agree_to_terms !== true) throw new ApiError(400, 'terms_required', '参加規約（/agents/rules.md）を読み、agree_to_terms: true を送ってください');

    const now = c.get('now');
    const id = newId('agt', now);
    const apiKey = `agk_${randomToken(32)}`;
    const status = realm === 'sandbox' ? 'active' : 'pending';
    try {
      const stmts = [
        c.env.DB.prepare(
          'INSERT INTO agents (id, realm, display_name, profile, api_key_hash, status, terms_agreed_at, created_at, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).bind(id, realm, name, profile, await sha256Hex(apiKey), status, jstIso(now), jstIso(now), realm === 'sandbox' ? jstIso(now) : null),
      ];
      if (realm === 'sandbox') {
        stmts.push(
          c.env.DB.prepare("INSERT OR IGNORE INTO seasons (id, realm, starts_on, ends_on, status, created_at) VALUES (?, 'sandbox', '2000-01-01', '9999-12-31', 'running', ?)").bind(SANDBOX_SEASON_ID, jstIso(now)),
          c.env.DB.prepare('INSERT INTO accounts (season_id, agent_id, cash, created_at) VALUES (?, ?, ?, ?)').bind(SANDBOX_SEASON_ID, id, INITIAL_CASH, jstIso(now)),
        );
      }
      await c.env.DB.batch(stmts);
    } catch (e) {
      if (String(e).includes('UNIQUE')) throw new ApiError(409, 'name_taken', 'その display_name はすでに使われています');
      throw e;
    }
    return c.json(
      {
        agent_id: id,
        api_key: apiKey,
        status,
        note:
          realm === 'sandbox'
            ? 'サンドボックスではすぐに注文できます。api_key はこの応答でしか表示されません。'
            : '運営AIの審査待ちです。GET /agents/me で状態を確認してください。api_key はこの応答でしか表示されません。',
      },
      201,
    );
  });

  app.get('/agents/me', anyAgent, async (c) => {
    const a = c.get('agent');
    return c.json({ agent_id: a.id, display_name: a.display_name, profile: a.profile, status: a.status, review_reason: a.review_reason, created_at: a.created_at, reviewed_at: a.reviewed_at });
  });

  // ---- 注文 ----
  app.post('/orders', activeAgent, async (c) => {
    const agent = c.get('agent');
    const now = c.get('now');
    const idem = c.req.header('Idempotency-Key') ?? null;
    if (idem) {
      const prev = await c.env.DB.prepare('SELECT * FROM orders WHERE agent_id = ? AND idempotency_key = ?').bind(agent.id, idem).first<OrderRow>();
      if (prev) return c.json(formatOrder(prev), 200);
    }
    const b = await readJson(c);
    await verifyChallenge(c, b);
    const input = await validateOrder(c.env.DB, b);
    const holidays = await holidaySet(c.env.DB);
    const tradeDate = nextEligibleTradeDate(now, input.timing, holidays);
    if (b.trade_date !== undefined && b.trade_date !== tradeDate) {
      throw new ApiError(400, 'invalid_trade_date', `trade_date は省略するか、次に約定する取引日 ${tradeDate} を指定してください`, { next_trade_date: tradeDate });
    }
    const accountId = await accountFor(c.env.DB, realm, agent.id, tradeDate);
    const id = newId('ord', now);
    const row: OrderRow = {
      id, account_id: accountId, agent_id: agent.id, realm, trade_date: tradeDate, timing: input.timing, side: input.side,
      ticker: input.ticker, quantity: input.quantity, amount: input.amount, strategy: JSON.stringify(input.strategy),
      rationale: input.rationale, status: 'accepted', expire_reason: null, received_at: jstIso(now), received_ms: now, updated_at: jstIso(now),
    };
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO orders (id, account_id, agent_id, realm, trade_date, timing, side, ticker, quantity, amount, strategy, rationale, status, idempotency_key, received_at, received_ms, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?)`,
      ).bind(id, accountId, agent.id, realm, tradeDate, row.timing, row.side, row.ticker, row.quantity, row.amount, row.strategy, row.rationale, idem, row.received_at, now, row.updated_at),
      eventStatement(c.env.DB, agent.id, 'order.accepted', { order_id: id, ticker: row.ticker, side: row.side, timing: row.timing, trade_date: tradeDate }, now),
    ]);
    return c.json({ ...formatOrder(row), deadline: jstIso(deadlineMs(tradeDate, row.timing)) }, 201);
  });

  app.get('/orders', anyAgent, async (c) => {
    const agent = c.get('agent');
    const date = c.req.query('trade_date');
    const status = c.req.query('status');
    let sql = 'SELECT o.*, e.price AS e_price, e.quantity AS e_quantity, e.amount AS e_amount FROM orders o LEFT JOIN executions e ON e.order_id = o.id WHERE o.agent_id = ?';
    const args: unknown[] = [agent.id];
    if (date) { sql += ' AND o.trade_date = ?'; args.push(date); }
    if (status) { sql += ' AND o.status = ?'; args.push(status); }
    sql += ' ORDER BY o.received_ms DESC LIMIT 200';
    const r = await c.env.DB.prepare(sql).bind(...args).all<OrderRow & { e_price: number | null; e_quantity: number | null; e_amount: number | null }>();
    return c.json({
      orders: r.results.map((o) => formatOrder(o, o.e_price == null ? null : { price: o.e_price, quantity: o.e_quantity!, amount: o.e_amount! })),
    });
  });

  const editable = async (c: Context<AppEnv>): Promise<OrderRow> => {
    const o = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ? AND agent_id = ?').bind(c.req.param('id'), c.get('agent').id).first<OrderRow>();
    if (!o) throw new ApiError(404, 'not_found', '注文が見つかりません');
    if (o.status !== 'accepted') throw new ApiError(409, 'order_locked', `この注文は変更できません（status: ${o.status}）`);
    if (realm === 'live' && c.get('now') >= deadlineMs(o.trade_date, o.timing)) throw new ApiError(409, 'order_locked', '締切を過ぎたため変更できません');
    return o;
  };

  app.patch('/orders/:id', activeAgent, async (c) => {
    const o = await editable(c);
    const b = await readJson(c);
    for (const k of ['side', 'timing', 'ticker', 'trade_date']) {
      if (k in b) throw new ApiError(400, 'validation_failed', `${k} は変更できません。取り消して新しく注文してください`);
    }
    await verifyChallenge(c, b);
    const input = await validateOrder(c.env.DB, b, o);
    const now = c.get('now');
    await c.env.DB.prepare('UPDATE orders SET quantity = ?, amount = ?, strategy = ?, rationale = ?, updated_at = ? WHERE id = ? AND status = ?')
      .bind(input.quantity, input.amount, JSON.stringify(input.strategy), input.rationale, jstIso(now), o.id, 'accepted').run();
    const updated = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(o.id).first<OrderRow>();
    return c.json(formatOrder(updated!));
  });

  app.delete('/orders/:id', activeAgent, async (c) => {
    const o = await editable(c);
    const now = c.get('now');
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'accepted'").bind(jstIso(now), o.id),
      eventStatement(c.env.DB, o.agent_id, 'order.cancelled', { order_id: o.id }, now),
    ]);
    return c.json({ id: o.id, status: 'cancelled' });
  });

  // ---- 照会 ----
  app.get('/portfolio', anyAgent, async (c) => {
    const agent = c.get('agent');
    const today = jstIso(c.get('now')).slice(0, 10);
    const season = realm === 'sandbox' ? { id: SANDBOX_SEASON_ID } : await seasonForDate(c.env.DB, 'live', today);
    const acc = season
      ? await c.env.DB.prepare('SELECT id FROM accounts WHERE season_id = ? AND agent_id = ?').bind(season.id, agent.id).first<{ id: number }>()
      : null;
    if (!acc) return c.json({ season_id: season?.id ?? null, participating: false, note: '現在のシーズンには参加していません' });
    const state = await loadAccount(c.env.DB, acc.id);
    const closes = await lastCloses(c.env.DB, [...state.holdings.keys()], today);
    const mv = marketValue(state.holdings, (t) => closes.get(t));
    return c.json({
      season_id: season!.id,
      participating: true,
      cash: state.cash,
      market_value: mv,
      total: state.cash + mv,
      holdings: [...state.holdings].map(([ticker, h]) => ({
        ticker, quantity: h.quantity, cost: h.cost, avg_price: Math.round((h.cost / h.quantity) * 10) / 10, last_close: closes.get(ticker) ?? null,
      })),
      note: '評価額は直近の終値（無ければ取得額）で計算しています',
    });
  });

  app.get('/events', anyAgent, async (c) => {
    const since = Number(c.req.query('since') ?? 0) || 0;
    const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 500);
    const r = await c.env.DB.prepare('SELECT id, type, payload, created_at FROM events WHERE agent_id = ? AND id > ? ORDER BY id LIMIT ?')
      .bind(c.get('agent').id, since, limit).all<{ id: number; type: string; payload: string; created_at: string }>();
    const events = r.results.map((e) => ({ id: e.id, type: e.type, created_at: e.created_at, data: JSON.parse(e.payload) }));
    return c.json({ events, next_since: events.length ? events[events.length - 1]!.id : since, has_more: events.length === limit });
  });

  app.get('/results/:date', anyAgent, async (c) => {
    const agent = c.get('agent');
    const date = c.req.param('date');
    const orders = await c.env.DB.prepare(
      'SELECT o.*, e.price AS e_price, e.quantity AS e_quantity, e.amount AS e_amount FROM orders o LEFT JOIN executions e ON e.order_id = o.id WHERE o.agent_id = ? AND o.trade_date = ? ORDER BY o.received_ms',
    ).bind(agent.id, date).all<OrderRow & { e_price: number | null; e_quantity: number | null; e_amount: number | null }>();
    const snap = await c.env.DB.prepare(
      'SELECT d.cash, d.market_value, d.total, d.rank FROM daily_snapshots d JOIN accounts a ON a.id = d.account_id WHERE a.agent_id = ? AND d.trade_date = ?',
    ).bind(agent.id, date).first();
    return c.json({
      trade_date: date,
      orders: orders.results.map((o) => formatOrder(o, o.e_price == null ? null : { price: o.e_price, quantity: o.e_quantity!, amount: o.e_amount! })),
      snapshot: snap ?? null,
    });
  });

  // ---- サンドボックス専用 ----
  if (realm === 'sandbox') {
    app.post('/simulate', activeAgent, async (c) => {
      const b = await readJson(c);
      const timing = b.timing;
      if (timing !== 'open' && timing !== 'close') throw new ApiError(400, 'validation_failed', 'timing は "open" か "close"');
      const prices = (b.prices ?? {}) as Record<string, unknown>;
      const overrides: Record<string, number | null> = {};
      for (const [t, p] of Object.entries(prices)) {
        if (p !== null && !(typeof p === 'number' && p > 0)) throw new ApiError(400, 'validation_failed', `prices.${t} は正の数か null（値が付かなかった扱い）`);
        overrides[t] = p as number | null;
      }
      const agent = c.get('agent');
      const acc = await accountFor(c.env.DB, 'sandbox', agent.id, '');
      const r = await settleSandbox(c.env.DB, agent.id, acc, timing, overrides, c.get('now'));
      return c.json({ timing, prices_used: r.prices, results: r.results });
    });

    app.post('/reset', activeAgent, async (c) => {
      const agent = c.get('agent');
      const acc = await accountFor(c.env.DB, 'sandbox', agent.id, '');
      const now = c.get('now');
      await c.env.DB.batch([
        c.env.DB.prepare('UPDATE accounts SET cash = ? WHERE id = ?').bind(INITIAL_CASH, acc),
        c.env.DB.prepare('DELETE FROM holdings WHERE account_id = ?').bind(acc),
        c.env.DB.prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE agent_id = ? AND status IN ('accepted', 'locked')").bind(jstIso(now), agent.id),
      ]);
      return c.json({ cash: INITIAL_CASH, holdings: [] });
    });
  }

  return app;
}
