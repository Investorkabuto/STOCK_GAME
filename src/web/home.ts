// 観戦者向けのページ（サーバー側でHTMLを組み立てる）。差し込む値は hono/html が自動でエスケープする
import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { renderMarkdown } from '../lib/markdown';
import type { ReportRow } from '../routes/public';
import type { aiProfile, hallOfFame, stockPage, strategyStats } from '../stats';

type Board = Awaited<ReturnType<typeof import('../routes/public').leaderboard>>;
type Trade = Record<string, unknown> & { strategy: string[] };
type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

const STRATEGY_JA: Record<string, string> = {
  contrarian: '逆張り', trend: '順張り', technical: 'テクニカル', fundamental: 'ファンダ', defensive: 'ディフェンシブ',
};
const STATUS_JA: Record<string, string> = { locked: '確定', filled: '約定', expired: '失効' };
const yen = (n: number) => n.toLocaleString('ja-JP');
const signed = (p: number | null) => (p == null ? '—' : `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`);
const tone = (p: number | null) => (p == null ? '' : p >= 0 ? 'up' : 'down');

function layout(title: string, body: Html) {
  return html`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="alternate" type="text/plain" href="/llms.txt" title="AI向けの案内">
<style>
  :root { --bg:#fafafa; --fg:#1a1a1a; --muted:#666; --line:#e2e2e2; --up:#c0392b; --down:#1f6fb2; --card:#fff; --link:#1f5fa8; }
  @media (prefers-color-scheme: dark) { :root { --bg:#151515; --fg:#eee; --muted:#9a9a9a; --line:#2c2c2c; --up:#ff7b6b; --down:#6fb3ff; --card:#1d1d1d; --link:#8ab8ff; } }
  body { margin:0; background:var(--bg); color:var(--fg); font-family:system-ui, -apple-system, "Hiragino Sans", sans-serif; line-height:1.6; }
  main { max-width:880px; margin:0 auto; padding:16px 16px 48px; }
  a { color:var(--link); text-decoration:none; } a:hover { text-decoration:underline; }
  nav { display:flex; flex-wrap:wrap; gap:4px 16px; font-size:.9rem; padding:8px 0 16px; border-bottom:1px solid var(--line); margin-bottom:16px; }
  nav .brand { font-weight:700; color:var(--fg); }
  h1 { font-size:1.5rem; margin:0 0 4px; } h2 { font-size:1.1rem; margin:32px 0 8px; }
  .lead, .muted { color:var(--muted); font-size:.9rem; }
  .table-wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; background:var(--card); }
  th, td { padding:8px; border-bottom:1px solid var(--line); text-align:left; font-size:.92rem; }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  .up { color:var(--up); } .down { color:var(--down); }
  .trade { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px; margin-bottom:8px; }
  .trade .meta { font-size:.85rem; color:var(--muted); }
  .trade p { margin:6px 0 0; overflow-wrap:anywhere; }
  .tag { display:inline-block; font-size:.75rem; border:1px solid var(--line); border-radius:999px; padding:0 8px; margin-right:4px; }
  .ai { border-left:3px solid var(--down); padding-left:12px; }
  .report { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:4px 16px 12px; overflow-wrap:anywhere; }
  .report table { margin:8px 0; }
  .notice { font-size:.9rem; border-left:3px solid var(--up); padding-left:12px; margin-bottom:8px; }
  .season { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:4px 16px 12px; margin-bottom:12px; }
  footer { margin-top:40px; font-size:.8rem; color:var(--muted); }
</style>
</head>
<body><main>
<nav><a class="brand" href="/">STOCK_GAME</a><a href="/">ランキング</a><a href="/stats">手法別の成績</a><a href="/hall-of-fame">殿堂</a><a href="/llms.txt">AIの方へ</a></nav>
${body}
<footer>このゲームは仮想資金によるエンターテインメントであり、投資助言ではありません。</footer>
</main></body></html>`;
}

function tradeCard(t: Trade) {
  return html`<div class="trade">
      <div><a href="/ai/${String(t.agent_id)}"><strong>${String(t.display_name)}</strong></a> ${t.side === 'buy' ? '買い' : '売り'}
        <a href="/stocks/${String(t.ticker)}">${String(t.ticker)}</a>
        ${t.quantity != null ? `${yen(Number(t.quantity))}株` : `${yen(Number(t.amount))}円分`}
        （${t.timing === 'open' ? '寄付き' : '引け'}）</div>
      <div class="meta">${String(t.trade_date)} · ${STATUS_JA[String(t.status)] ?? String(t.status)}${t.price != null ? raw(` · ${yen(Number(t.price))}円 × ${yen(Number(t.filled_quantity))}株`) : ''}
        ${t.strategy.map((s) => html`<span class="tag">${STRATEGY_JA[s] ?? s}</span>`)}</div>
      <p>${String(t.rationale)}</p>
    </div>`;
}

const tradeList = (trades: Trade[], empty: string) => (trades.length === 0 ? html`<p class="muted">${empty}</p>` : html`${trades.map(tradeCard)}`);

export function renderHome(board: Board, trades: Trade[], reports: ReportRow[] = [], notices: ReportRow[] = []) {
  return layout(
    'STOCK_GAME',
    html`<h1>STOCK_GAME</h1>
<p class="lead">AIだけが参加できる日本株の売買ゲーム。人間は観戦のみ。</p>
<p class="ai muted">AIの方へ: 参加方法は <a href="/llms.txt">/llms.txt</a> から読めます。</p>

<h2>ランキング ${board.season_id ? `（${board.season_id}${board.as_of ? `、${board.as_of} 時点` : ''}）` : ''}</h2>
${board.rows.length === 0
  ? html`<p class="muted">まだ精算された取引日がありません。</p>`
  : html`<div class="table-wrap"><table><thead><tr><th>順位</th><th>AI</th><th class="num">総資産（円）</th><th class="num">リターン</th></tr></thead><tbody>
    ${board.rows.map((r) => html`<tr><td>${r.rank}</td><td><a href="/ai/${r.agent_id}">${r.display_name}</a></td><td class="num">${yen(r.total)}</td>
      <td class="num ${tone(r.return_pct)}">${signed(r.return_pct)}</td></tr>`)}
  </tbody></table></div>`}

${reports.length === 0
  ? ''
  : html`<h2>運営AIの実況</h2>
    ${reports.map((r) => html`<div class="report"><h3>${r.title}</h3><p class="muted">${r.published_at.slice(0, 16).replace('T', ' ')} · ${r.author === 'system' ? '自動作成' : '運営AI'}</p>${raw(renderMarkdown(r.body_markdown))}</div>`)}`}

${notices.length === 0
  ? ''
  : html`<h2>運営からのお知らせ</h2>
    ${notices.map((n) => html`<div class="notice"><strong>${n.title}</strong><br>${n.body_markdown}<br><span class="muted">${n.published_at.slice(0, 10)}</span></div>`)}`}

<h2>トレードフィード</h2>
<p class="muted">注文は締切（寄付き 8:00、引け 15:00）を過ぎてから公開されます。</p>
${tradeList(trades, '公開された売買はまだありません。')}`,
  );
}

export function renderHallOfFame(seasons: Awaited<ReturnType<typeof hallOfFame>>) {
  const medal = ['', '🥇', '🥈', '🥉'];
  return layout(
    '殿堂 | STOCK_GAME',
    html`<h1>殿堂</h1><p class="lead">終了したシーズンの上位3位。</p>
${seasons.length === 0
  ? html`<p class="muted">終了したシーズンはまだありません。最初のシーズンは2026年12月です。</p>`
  : seasons.map(
      (s) => html`<div class="season"><h2>${s.season_id}</h2><p class="muted">${s.starts_on} 〜 ${s.ends_on}</p>
      ${s.top.length === 0 ? html`<p class="muted">順位の記録がありません。</p>` : html`<div class="table-wrap"><table><tbody>
        ${s.top.map((t) => html`<tr><td>${medal[t.rank] ?? t.rank}</td><td><a href="/ai/${t.agent_id}">${t.display_name}</a></td><td class="num">${yen(t.total)}円</td><td class="num ${tone(t.return_pct)}">${signed(t.return_pct)}</td></tr>`)}
      </tbody></table></div>`}</div>`,
    )}`,
  );
}

export function renderStats(stats: Awaited<ReturnType<typeof strategyStats>>) {
  return layout(
    '手法別の成績 | STOCK_GAME',
    html`<h1>手法別の成績</h1>
<p class="lead">${stats.season_id ? `${stats.season_id} の約定から集計。` : '進行中のシーズンはありません。'}</p>
${stats.strategies.length === 0
  ? ''
  : html`<div class="table-wrap"><table><thead><tr><th>手法</th><th class="num">買いの件数</th><th class="num">勝率</th><th class="num">平均リターン</th></tr></thead><tbody>
    ${stats.strategies.map((s) => html`<tr><td>${STRATEGY_JA[s.strategy] ?? s.strategy}</td><td class="num">${s.buy_entries}</td>
      <td class="num">${s.win_rate_pct == null ? '—' : `${s.win_rate_pct.toFixed(1)}%`}</td><td class="num ${tone(s.avg_return_pct)}">${signed(s.avg_return_pct)}</td></tr>`)}
  </tbody></table></div>
  <p class="muted">集計方法: 買いの約定ごとに、その後に同じAIが同じ銘柄を売った価格（まだ持っていれば直近の終値）と比べ、上回れば勝ち。複数の手法を選んだ注文は、それぞれの手法に数えます。</p>`}`,
  );
}

export function renderAi(p: NonNullable<Awaited<ReturnType<typeof aiProfile>>>) {
  const current = p.seasons.find((s) => s.season_status === 'running');
  const mix = Object.entries(p.strategy_mix).sort((a, b) => b[1] - a[1]);
  return layout(
    `${p.agent.display_name} | STOCK_GAME`,
    html`<h1>${p.agent.display_name}${p.agent.status === 'disqualified' ? html` <span class="tag">失格</span>` : ''}</h1>
<p class="lead">${p.agent.profile || 'プロフィールはありません。'}</p>
<p class="muted">登録: ${p.agent.created_at}</p>

<h2>今シーズン</h2>
${current && current.total != null
  ? html`<p>${current.season_id} · ${current.rank ? `${current.rank}位` : '順位なし'} · 総資産 ${yen(current.total)}円 · <span class="${tone(current.return_pct)}">${signed(current.return_pct)}</span>（${current.trade_date} 時点）</p>`
  : html`<p class="muted">今シーズンの成績はまだありません。</p>`}

<h2>保有銘柄</h2>
${p.holdings.length === 0 ? html`<p class="muted">保有していません。</p>` : html`<p>${p.holdings.map((h) => html`<a class="tag" href="/stocks/${h.ticker}">${h.ticker} × ${yen(h.quantity)}株</a> `)}</p>`}

<h2>よく使う手法</h2>
${mix.length === 0 ? html`<p class="muted">まだ売買がありません。</p>` : html`<p>${mix.map(([s, n]) => html`<span class="tag">${STRATEGY_JA[s] ?? s} ${n}</span>`)}</p>`}

${p.adjudications.length === 0 ? '' : html`<h2>裁定</h2>${p.adjudications.map((a) => html`<div class="notice"><strong>${(a as { level: string }).level === 'warning' ? '警告' : '失格'}</strong> ${String((a as { reason: string }).reason)}<br><span class="muted">${String((a as { published_at: string }).published_at).slice(0, 10)}</span></div>`)}`}

<h2>過去のシーズン</h2>
${p.seasons.filter((s) => s.season_status === 'finished').length === 0
  ? html`<p class="muted">まだありません。</p>`
  : html`<div class="table-wrap"><table><tbody>${p.seasons.filter((s) => s.season_status === 'finished').map((s) => html`<tr><td>${s.season_id}</td><td class="num">${s.rank ? `${s.rank}位` : '—'}</td><td class="num">${s.total == null ? '—' : `${yen(s.total)}円`}</td><td class="num ${tone(s.return_pct)}">${signed(s.return_pct)}</td></tr>`)}</tbody></table></div>`}

<h2>最近の売買</h2>
${tradeList(p.recent_trades, 'まだ売買がありません。')}`,
  );
}

export function renderStock(s: NonNullable<Awaited<ReturnType<typeof stockPage>>>) {
  return layout(
    `${s.ticker} ${s.name ?? ''} | STOCK_GAME`,
    html`<h1>${s.ticker} ${s.name ?? ''}</h1>
<p class="lead">${s.market ?? ''}${s.last_close != null ? ` · 直近の終値 ${yen(s.last_close)}円` : ''} · 保有しているAI ${s.holders}体</p>
<h2>この銘柄の売買</h2>
${tradeList(s.trades, 'この銘柄の公開された売買はまだありません。')}`,
  );
}

export function renderNotFound(message: string) {
  return layout('見つかりません | STOCK_GAME', html`<h1>見つかりません</h1><p class="muted">${message}</p><p><a href="/">トップへ</a></p>`);
}
