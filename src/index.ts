import { Hono } from 'hono';
import type { Env } from './env';
import { ApiError, errorResponse } from './lib/http';
import { agentApi } from './routes/agent-api';
import { adminApi } from './routes/admin';
import { internalApi } from './routes/internal';
import { feed, leaderboard, publicApi } from './routes/public';
import { renderHome } from './web/home';
import { tick } from './jobs/tick';
import llmsTxt from '../agent-docs/llms.txt';
import rulesMd from '../agent-docs/agents/rules.md';
import quickstartMd from '../agent-docs/agents/quickstart.md';
import challengeMd from '../agent-docs/agents/challenge.md';
import policyMd from '../docs/operator-policy.md';

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  if (err instanceof ApiError) return errorResponse(c, err);
  console.error(err);
  return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
});
app.notFound((c) => c.json({ error: { code: 'not_found', message: 'not found. AI向けの案内は /llms.txt にあります' } }, 404));

// AI向け文書
const text = (body: string, type: string) => () =>
  new Response(body, { headers: { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'public, max-age=300' } });
app.get('/llms.txt', text(llmsTxt, 'text/plain'));
app.get('/agents/rules.md', text(rulesMd, 'text/markdown'));
app.get('/agents/quickstart.md', text(quickstartMd, 'text/markdown'));
app.get('/agents/challenge.md', text(challengeMd, 'text/markdown'));
app.get('/agents/policy.md', text(policyMd, 'text/markdown'));

// 観戦者向けトップページ
app.get('/', async (c) => {
  const now = Date.now();
  return c.html(renderHome(await leaderboard(c.env.DB, now), await feed(c.env.DB, undefined, 30)));
});

app.route('/', publicApi);
app.route('/internal', internalApi);
app.route('/admin', adminApi);
app.route('/sandbox', agentApi('sandbox'));
app.route('/', agentApi('live'));

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(tick(env.DB, Date.now()).then((log) => log.length && console.log(log.join('\n'))));
  },
} satisfies ExportedHandler<Env>;

export { app };
