// 管理者（ユーザー）向け。ADMIN_TOKEN で認証する。運営AI（もち）の接続は開発第2段階で operator API として追加する。
import { Hono } from 'hono';
import { INITIAL_CASH, type Env } from '../env';
import { eventStatement, type SeasonRow } from '../db/repo';
import { tick } from '../jobs/tick';
import { ApiError, bearer, readJson, safeEqual } from '../lib/http';
import { jstIso, registrationDeadlineMs } from '../lib/time';

export const adminApi = new Hono<{ Bindings: Env }>();

adminApi.use('*', async (c, next) => {
  const t = bearer(c);
  if (!c.env.ADMIN_TOKEN || !t || !safeEqual(t, c.env.ADMIN_TOKEN)) throw new ApiError(401, 'unauthorized', 'invalid admin token');
  await next();
});

adminApi.get('/agents', async (c) => {
  const status = c.req.query('status') ?? 'pending';
  const r = await c.env.DB.prepare("SELECT id, display_name, profile, status, created_at FROM agents WHERE realm = 'live' AND status = ? ORDER BY created_at").bind(status).all();
  return c.json({ agents: r.results });
});

async function review(c: { env: Env; req: { param: (k: string) => string } }, decision: 'approve' | 'reject', reason: string) {
  const db = c.env.DB;
  const id = c.req.param('id');
  const agent = await db.prepare("SELECT id, created_at, status FROM agents WHERE id = ? AND realm = 'live'").bind(id).first<{ id: string; created_at: string; status: string }>();
  if (!agent) throw new ApiError(404, 'not_found', 'agent not found');
  if (agent.status !== 'pending') throw new ApiError(409, 'conflict', `agent is ${agent.status}`);
  const nowMs = Date.now();
  const status = decision === 'approve' ? 'active' : 'rejected';
  const stmts = [
    db.prepare('UPDATE agents SET status = ?, review_reason = ?, reviewed_at = ? WHERE id = ?').bind(status, reason || null, jstIso(nowMs), id),
    eventStatement(db, id, 'agent.reviewed', { decision, reason }, nowMs),
  ];
  // 締切までに申請していれば、すでに始まったシーズンにも参加させる（審査の遅れで不利にしない）
  if (decision === 'approve') {
    const seasons = (await db.prepare("SELECT * FROM seasons WHERE realm = 'live' AND status = 'running'").all<SeasonRow>()).results;
    for (const s of seasons) {
      if (agent.created_at <= jstIso(registrationDeadlineMs(s.starts_on))) {
        stmts.push(
          db.prepare('INSERT OR IGNORE INTO accounts (season_id, agent_id, cash, created_at) VALUES (?, ?, ?, ?)').bind(s.id, id, INITIAL_CASH, jstIso(nowMs)),
          eventStatement(db, id, 'season.started', { season_id: s.id, starts_on: s.starts_on, ends_on: s.ends_on, cash: INITIAL_CASH }, nowMs),
        );
      }
    }
  }
  await db.batch(stmts);
  return { id, status };
}

adminApi.post('/agents/:id/approve', async (c) => {
  const b: Record<string, unknown> = await readJson(c).catch(() => ({}));
  return c.json(await review(c, 'approve', typeof b.reason === 'string' ? b.reason : ''));
});
adminApi.post('/agents/:id/reject', async (c) => {
  const b = await readJson(c);
  if (typeof b.reason !== 'string' || !b.reason.trim()) throw new ApiError(400, 'bad_request', 'reason is required');
  return c.json(await review(c, 'reject', b.reason.trim()));
});

/** 状態機械を今すぐ1回進める（動作確認・復旧用） */
adminApi.post('/tick', async (c) => {
  const at = c.req.query('now');
  let now = Date.now();
  if (at) {
    if (c.env.ALLOW_TIME_TRAVEL !== '1') throw new ApiError(400, 'bad_request', 'now is only allowed when ALLOW_TIME_TRAVEL=1');
    now = Date.parse(at);
    if (Number.isNaN(now)) throw new ApiError(400, 'bad_request', 'invalid now');
  }
  return c.json({ log: await tick(c.env.DB, now) });
});
