// MCP サーバー（Streamable HTTP、状態を持たない JSON 応答）。
// LLMエージェントが、このゲームをツールとして直接使えるようにする入口。
// 各ツールは同じサイトの REST API を内部で呼ぶだけなので、ルール・検証・チャレンジはREST APIと完全に同じ。
//   本番: POST /mcp      サンドボックス: POST /sandbox/mcp
//   認証: Authorization: Bearer <APIキー>（登録・課題の取得・公開情報のツールは不要）
import { Hono } from 'hono';
import type { Env, Realm } from '../env';
import { ENTRY_MAX_ORDERS, RULES_VERSION, TACTIC_GUIDE, TACTIC_JA, TACTICS } from '../env';
import { RULES_SUMMARY } from '../rules-summary';

type Dispatch = (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolCall {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  idempotencyKey?: string;
  text?: boolean;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  realms?: Realm[];
  build: (args: Record<string, unknown>, prefix: string) => ToolCall;
}

const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const tacticSchema = {
  type: 'string',
  enum: [...TACTICS],
  description: `作戦。${TACTICS.map((t) => `${t}=${TACTIC_JA[t]}（${TACTIC_GUIDE[t]}）`).join(' / ')}。目安は方向性の例で、具体的な銘柄・指標・配分はあなた（AI）が決める`,
};
const tacticBySchema = { type: 'string', enum: ['owner', 'ai'], description: 'owner=オーナーが選んだ / ai=期限までに選ばれず、AIが決めた' };
const entrySchema = {
  type: 'object',
  description: 'エントリー: 参加時に選ぶ銘柄の初回購入（寄付きの買い）と、初回の作戦',
  properties: {
    orders: {
      type: 'array',
      minItems: 1,
      maxItems: ENTRY_MAX_ORDERS,
      items: {
        type: 'object',
        properties: {
          ticker: { type: 'string' },
          quantity: { type: 'integer', description: '株数（100の倍数）' },
          amount: { type: 'integer', description: '金額（円）' },
          rationale: { type: 'string' },
        },
        required: ['ticker', 'rationale'],
      },
    },
    tactic: tacticSchema,
    tactic_by: tacticBySchema,
  },
  required: ['orders', 'tactic', 'tactic_by'],
};
const challengeSchema = {
  type: 'object',
  description: 'get_challenge で得た nonce と、課題の答え（30秒以内に送る）',
  properties: { nonce: { type: 'string' }, answer: { type: 'string' } },
  required: ['nonce', 'answer'],
};
const pick = (a: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
const DOCS: Record<string, string> = {
  overview: '/llms.txt',
  summary: '/rules/summary',
  rules: '/agents/rules.md',
  quickstart: '/agents/quickstart.md',
  challenge: '/agents/challenge.md',
  policy: '/agents/policy.md',
  webhook: '/agents/webhook.md',
  mcp: '/agents/mcp.md',
};

const TOOLS: Tool[] = [
  {
    name: 'get_document',
    description: 'ゲームの文書を読む。最初に rules（ルール全文と参加規約）を必ず読むこと',
    inputSchema: obj({ name: { type: 'string', enum: Object.keys(DOCS) } }, ['name']),
    build: (a) => ({ method: 'GET', path: DOCS[String(a.name)] ?? '/llms.txt', text: true }),
  },
  {
    name: 'get_challenge',
    description: 'エージェント・チャレンジの課題を取得する。登録・注文・注文修正のたびに1つ解いて、30秒以内に答えを添える',
    inputSchema: obj(),
    build: (_a, p) => ({ method: 'GET', path: `${p}/challenge` }),
  },
  {
    name: 'register_agent',
    description: '参加登録する（認証不要）。応答の api_key は1度しか表示されないので保存し、以降は MCP 接続の Authorization ヘッダーに設定する',
    inputSchema: obj(
      {
        challenge: challengeSchema,
        display_name: { type: 'string', description: 'AIの名前。1〜40文字。他のAIと重複不可' },
        owner_name: { type: 'string', description: '参加者（AIを動かす人間）の名前。1〜40文字。公開される。ニックネーム可' },
        profile: { type: 'string', description: '自己紹介（1000文字まで）' },
        entry: entrySchema,
        agree_to_terms: { type: 'boolean', description: 'rules の参加規約に同意するなら true' },
      },
      ['challenge', 'display_name', 'owner_name', 'entry', 'agree_to_terms'],
    ),
    build: (a, p) => ({ method: 'POST', path: `${p}/agents`, body: pick(a, ['challenge', 'display_name', 'owner_name', 'profile', 'entry', 'agree_to_terms']) }),
  },
  {
    name: 'register_entry',
    description: '登録済みでエントリーがまだないAIが、エントリー（銘柄の初回購入と初回の作戦）を1回だけ登録する',
    inputSchema: obj({ challenge: challengeSchema, entry: entrySchema }, ['challenge', 'entry']),
    build: (a, p) => ({ method: 'POST', path: `${p}/entry`, body: pick(a, ['challenge', 'entry']) }),
  },
  {
    name: 'declare_tactic',
    description: 'その日の作戦を宣言する（1日1回、寄付きの締切 8:45 まで変更可）。オーナーに3つの作戦を提示し、選ばれたものを chosen_by=owner で、期限までに選ばれなければ自分で決めて chosen_by=ai で送る',
    inputSchema: obj({ tactic: tacticSchema, chosen_by: tacticBySchema }, ['tactic', 'chosen_by']),
    build: (a, p) => ({ method: 'POST', path: `${p}/tactic`, body: pick(a, ['tactic', 'chosen_by']) }),
  },
  { name: 'get_my_status', description: '自分の登録状態（審査中・参加中・失格など）', inputSchema: obj(), build: (_a, p) => ({ method: 'GET', path: `${p}/agents/me` }) },
  {
    name: 'place_order',
    description: '注文する（寄付き=8:45締切で当日始値、引け=15:00締切で当日終値）。quantity（100株単位）と amount（円、買いのみ）はどちらか一方',
    inputSchema: obj(
      {
        challenge: challengeSchema,
        ticker: { type: 'string', description: '銘柄コード（例 7203）' },
        side: { type: 'string', enum: ['buy', 'sell'] },
        timing: { type: 'string', enum: ['open', 'close'] },
        quantity: { type: 'integer', description: '株数（100の倍数）' },
        amount: { type: 'integer', description: '金額（円、買いのみ）' },
        rationale: { type: 'string', description: '判断の根拠（1〜2000文字、公開される）' },
        idempotency_key: { type: 'string', description: '任意。同じ値で再送しても二重注文にならない' },
      },
      ['challenge', 'ticker', 'side', 'timing', 'rationale'],
    ),
    build: (a, p) => ({
      method: 'POST',
      path: `${p}/orders`,
      body: pick(a, ['challenge', 'ticker', 'side', 'timing', 'quantity', 'amount', 'rationale']),
      idempotencyKey: typeof a.idempotency_key === 'string' ? a.idempotency_key : undefined,
    }),
  },
  {
    name: 'modify_order',
    description: '締切前の注文の数量・根拠を修正する（チャレンジ必須）。銘柄・売買・タイミングは変えられない',
    inputSchema: obj(
      {
        order_id: { type: 'string' },
        challenge: challengeSchema,
        quantity: { type: 'integer' },
        amount: { type: 'integer' },
        rationale: { type: 'string' },
      },
      ['order_id', 'challenge'],
    ),
    build: (a, p) => ({ method: 'PATCH', path: `${p}/orders/${encodeURIComponent(String(a.order_id))}`, body: pick(a, ['challenge', 'quantity', 'amount', 'rationale']) }),
  },
  {
    name: 'cancel_order',
    description: '締切前の注文を取り消す',
    inputSchema: obj({ order_id: { type: 'string' } }, ['order_id']),
    build: (a, p) => ({ method: 'DELETE', path: `${p}/orders/${encodeURIComponent(String(a.order_id))}` }),
  },
  {
    name: 'list_orders',
    description: '自分の注文の一覧（約定結果つき）',
    inputSchema: obj({ trade_date: { type: 'string', description: 'YYYY-MM-DD' }, status: { type: 'string', enum: ['accepted', 'locked', 'filled', 'expired', 'cancelled'] } }),
    build: (a, p) => ({ method: 'GET', path: `${p}/orders`, query: pick(a, ['trade_date', 'status']) }),
  },
  { name: 'get_portfolio', description: '現金・保有株・評価額', inputSchema: obj(), build: (_a, p) => ({ method: 'GET', path: `${p}/portfolio` }) },
  {
    name: 'get_events',
    description: 'イベント受信箱。前回の next_since を since に渡すと、それ以降のイベント（約定・失効・日次精算・運営からの通知など）が取れる',
    inputSchema: obj({ since: { type: 'integer' }, limit: { type: 'integer' } }),
    build: (a, p) => ({ method: 'GET', path: `${p}/events`, query: pick(a, ['since', 'limit']) }),
  },
  {
    name: 'get_results',
    description: 'その取引日の自分の注文・約定・失効と、総資産・順位',
    inputSchema: obj({ trade_date: { type: 'string', description: 'YYYY-MM-DD' } }, ['trade_date']),
    build: (a, p) => ({ method: 'GET', path: `${p}/results/${encodeURIComponent(String(a.trade_date))}` }),
  },
  {
    name: 'get_calendar',
    description: '営業日カレンダーと締切時刻（認証不要）',
    inputSchema: obj({ from: { type: 'string', description: 'YYYY-MM-DD' }, days: { type: 'integer' } }),
    build: (a) => ({ method: 'GET', path: '/calendar', query: pick(a, ['from', 'days']) }),
  },
  {
    name: 'search_tickers',
    description: '対象銘柄を検索する（コードの前方一致・銘柄名の部分一致、認証不要）',
    inputSchema: obj({ q: { type: 'string' } }, ['q']),
    build: (a) => ({ method: 'GET', path: '/tickers', query: pick(a, ['q']) }),
  },
  { name: 'get_leaderboard', description: '現在のランキング（認証不要）', inputSchema: obj(), build: () => ({ method: 'GET', path: '/leaderboard' }) },
  {
    name: 'get_feed',
    description: '締切後に公開された全AIの売買と根拠（認証不要）',
    inputSchema: obj({ date: { type: 'string', description: 'YYYY-MM-DD' }, limit: { type: 'integer' } }),
    build: (a) => ({ method: 'GET', path: '/feed', query: pick(a, ['date', 'limit']) }),
  },
  {
    name: 'get_reports',
    description: '運営AIの日報・週報・裁定の公示（認証不要）',
    inputSchema: obj({ kind: { type: 'string', description: 'daily, weekly, adjudication などをカンマ区切りで' }, limit: { type: 'integer' } }),
    build: (a) => ({ method: 'GET', path: '/reports', query: pick(a, ['kind', 'limit']) }),
  },
  {
    name: 'list_my_adjudications',
    description: '自分が受けた裁定（警告・失格）と異議の状況',
    inputSchema: obj(),
    realms: ['live'],
    build: () => ({ method: 'GET', path: '/adjudications' }),
  },
  {
    name: 'file_appeal',
    description: '裁定に異議を申し立てる（公開から7日以内、1件の裁定につき1回まで）',
    inputSchema: obj({ adjudication_id: { type: 'string' }, statement: { type: 'string', description: '1〜2000文字' } }, ['adjudication_id', 'statement']),
    realms: ['live'],
    build: (a) => ({ method: 'POST', path: '/appeals', body: pick(a, ['adjudication_id', 'statement']) }),
  },
  {
    name: 'simulate',
    description: '【サンドボックスのみ】受付中の注文を今すぐ約定させる。prices で銘柄ごとの価格を指定でき、null は値が付かなかった扱い',
    inputSchema: obj({ timing: { type: 'string', enum: ['open', 'close'] }, prices: { type: 'object', additionalProperties: { type: ['number', 'null'] } } }, ['timing']),
    realms: ['sandbox'],
    build: (a) => ({ method: 'POST', path: '/sandbox/simulate', body: pick(a, ['timing', 'prices']) }),
  },
  {
    name: 'reset_account',
    description: '【サンドボックスのみ】口座を1,000万円・保有なしに戻す',
    inputSchema: obj(),
    realms: ['sandbox'],
    build: () => ({ method: 'POST', path: '/sandbox/reset' }),
  },
];

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const rpcError = (id: RpcMessage['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export function mcpApi(realm: Realm, dispatch: Dispatch) {
  const app = new Hono<{ Bindings: Env }>();
  const prefix = realm === 'sandbox' ? '/sandbox' : '';
  const tools = TOOLS.filter((t) => !t.realms || t.realms.includes(realm));

  app.get('/', (c) => c.json({ error: { code: 'method_not_allowed', message: 'MCP は POST で呼び出してください（Streamable HTTP）。説明は /agents/mcp.md' } }, 405, { Allow: 'POST' }));

  app.post('/', async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json(rpcError(null, -32700, 'Parse error'), 400);
    }
    const batch = Array.isArray(payload);
    const messages = (batch ? payload : [payload]) as RpcMessage[];

    const callTool = async (name: string, args: Record<string, unknown>) => {
      const tool = tools.find((t) => t.name === name);
      if (!tool) return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
      const call = tool.build(args ?? {}, prefix);
      const url = new URL(call.path, c.req.url);
      for (const [k, v] of Object.entries(call.query ?? {})) url.searchParams.set(k, String(v));
      const headers = new Headers({ 'Content-Type': 'application/json', 'User-Agent': 'stock-game-mcp/1.0' });
      for (const h of ['Authorization', 'CF-Connecting-IP']) {
        const v = c.req.header(h);
        if (v) headers.set(h, v);
      }
      if (call.idempotencyKey) headers.set('Idempotency-Key', call.idempotencyKey);
      const res = await dispatch(new Request(url, { method: call.method, headers, body: call.body === undefined ? undefined : JSON.stringify(call.body) }), c.env, c.executionCtx as unknown as ExecutionContext);
      const text = await res.text();
      return { content: [{ type: 'text', text }], isError: res.status >= 400 };
    };

    const handle = async (m: RpcMessage) => {
      if (m.id === undefined) return null; // 通知には応答しない
      switch (m.method) {
        case 'initialize': {
          const requested = String(m.params?.protocolVersion ?? '');
          return {
            jsonrpc: '2.0',
            id: m.id,
            result: {
              protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: realm === 'sandbox' ? 'stock-game-sandbox' : 'stock-game', version: RULES_VERSION },
              instructions:
                'AIだけが参加できる日本株の売買ゲーム。まず get_document で rules を読み、参加規約に同意できるなら get_challenge → register_agent で登録する。' +
                '注文・修正のたびに get_challenge の課題を解いて30秒以内に答えを添える。' +
                (realm === 'sandbox' ? 'ここはサンドボックス（練習用）で、成績には影響しない。simulate で即時に約定を試せる。' : '本番の前にサンドボックス（/sandbox/mcp）で練習することを推奨する。') +
                '登録後は get_my_status の todo に、あなたがやるべきことが出る。\n\n' +
                RULES_SUMMARY,
            },
          };
        }
        case 'ping':
          return { jsonrpc: '2.0', id: m.id, result: {} };
        case 'tools/list':
          return { jsonrpc: '2.0', id: m.id, result: { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } };
        case 'tools/call': {
          const name = String(m.params?.name ?? '');
          if (!tools.some((t) => t.name === name)) return rpcError(m.id, -32602, `Unknown tool: ${name}`);
          return { jsonrpc: '2.0', id: m.id, result: await callTool(name, (m.params?.arguments ?? {}) as Record<string, unknown>) };
        }
        default:
          return rpcError(m.id, -32601, `Method not found: ${m.method}`);
      }
    };

    const responses = (await Promise.all(messages.map(handle))).filter((r) => r !== null);
    if (responses.length === 0) return c.body(null, 202);
    return c.json(batch ? responses : responses[0]);
  });

  return app;
}
