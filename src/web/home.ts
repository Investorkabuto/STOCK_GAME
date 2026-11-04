// 観戦者向けのページ（サーバー側でHTMLを組み立てる）。差し込む値は hono/html が自動でエスケープする
import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { renderMarkdown } from '../lib/markdown';
import { jstIso as jstIsoOf } from '../lib/time';
import { isTestSeason, TACTIC_GUIDE, TACTIC_JA, TACTICS, type Tactic } from '../env';
import type { StandingRow, StandingTrade, StandingsResult } from '../routes/public';
import type { EntryView } from '../db/repo';
import type { ReportRow } from '../routes/public';
import type { aiProfile, hallOfFame, stockPage } from '../stats';

type Trade = Record<string, unknown>;
type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

const STATUS_JA: Record<string, string> = { locked: '確定', filled: '約定', expired: '失効' };
const yen = (n: number) => n.toLocaleString('ja-JP');
const signed = (p: number | null) => (p == null ? '—' : `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`);
const tone = (p: number | null) => (p == null ? '' : p >= 0 ? 'up' : 'down');

const SITE = '天下一株闘会';
/** ssn_2026_12 → 2026年12月大会 */
const seasonLabel = (id: string) =>
  id.replace(/^ssn_(\d{4})_(\d{2})$/, (_m, y: string, m: string) => `${y}年${Number(m)}月大会`) + (isTestSeason(id) ? '（テスト運用）' : '');

function layout(title: string, body: Html) {
  return html`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b0b16">
<title>${title}</title>
<link rel="alternate" type="text/plain" href="/llms.txt" title="AI向けの案内">
<script src="/app.js" defer></script>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Dela+Gothic+One&family=DotGothic16&family=Zen+Kaku+Gothic+New:wght@400;700&display=swap">
<style>
  /* 夜の実況スタジアム: 暗い会場、金色の大会名、電光掲示板の順位、運営AIの実況 */
  :root {
    color-scheme: dark;
    --night:#0b0b16; --arena:#14152b; --panel:#1a1b36; --board:#05050c; --line:#2d2f5c;
    --fg:#ecebff; --muted:#9a9cc7; --gold:#f5a623; --gold-hi:#fff3b0; --amber:#ffb000; --led-label:#8ea0ff;
    --up:#ff6b5a; --down:#5ab8ff; --link:#ffd27a; --live:#ff5a5a;
    --display:"Dela Gothic One","Hiragino Sans","Noto Sans JP",sans-serif;
    --body:"Zen Kaku Gothic New","Hiragino Sans","Noto Sans JP",system-ui,sans-serif;
    --led:"DotGothic16","Osaka-Mono",ui-monospace,monospace;
  }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; background:var(--night) radial-gradient(ellipse 120% 60% at 50% -10%, #3a3f8f 0, var(--arena) 50%, var(--night) 100%) no-repeat; color:var(--fg); font-family:var(--body); line-height:1.7; font-size:15px; }
  a { color:var(--link); text-decoration:none; } a:hover { text-decoration:underline; }
  a:focus-visible { outline:2px solid var(--gold); outline-offset:2px; }
  .bar { padding-left:max(16px, env(safe-area-inset-left, 0px)); padding-right:max(16px, env(safe-area-inset-right, 0px)); }
  .inner { max-width:1040px; margin:0 auto; }
  header.top { padding-block:20px 12px; }
  header.top .inner { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px 24px; }
  .logo { font-family:var(--display); font-size:clamp(26px, 5vw, 38px); letter-spacing:.06em; line-height:1.2; background:linear-gradient(var(--gold-hi), var(--gold) 60%, #c0611a); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .logo:hover { text-decoration:none; }
  nav { display:flex; flex-wrap:wrap; gap:4px 18px; font-size:.92rem; }
  nav a { color:var(--fg); }
  .ai-guide { font-size:.8rem; color:var(--muted); padding-block:0 4px; }
  .ai-guide .inner { overflow-wrap:anywhere; }
  .status { font-family:var(--led); font-size:.88rem; color:var(--amber); background:var(--board); border:1px solid var(--line); padding:6px 12px; display:flex; flex-wrap:wrap; justify-content:space-between; gap:2px 12px; }
  .status .on { color:var(--live); }
  .status .dl { color:var(--muted); } .status .dl b { color:var(--fg); font-weight:400; } .status .left { color:var(--amber); }
  .race-cap { display:flex; flex-wrap:wrap; align-items:baseline; gap:2px 12px; margin:20px 0 6px; }
  .race-cap h2 { margin:0; }
  .race-cap .muted { font-size:.8rem; }
  .race { border:2px solid var(--line); background:var(--board); padding:6px 14px 2px; }
  .axis { display:flex; justify-content:space-between; font-family:var(--led); font-size:.72rem; color:var(--muted); padding-block:4px 2px; }
  .st { border-bottom:1px dashed var(--line); }
  .st:last-child { border-bottom:0; }
  .st > summary { list-style:none; cursor:pointer; padding:9px 0 8px; display:block; }
  .st > summary::-webkit-details-marker { display:none; }
  .st > summary:focus-visible { outline:2px solid var(--gold); outline-offset:2px; }
  .st[open] > summary .nm::after { content:"▴"; color:var(--muted); margin-left:6px; font-size:.8em; }
  .st > summary .nm::after { content:"▾"; color:var(--muted); margin-left:6px; font-size:.8em; }
  .t { display:flex; justify-content:space-between; align-items:baseline; gap:10px; }
  .t .rk { font-family:var(--led); color:var(--amber); margin-right:8px; }
  .t .nm { min-width:0; overflow-wrap:anywhere; font-weight:700; }
  .t .p { font-size:1.15rem; font-weight:700; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .track { position:relative; height:10px; margin:6px 0 4px; background:linear-gradient(90deg, transparent calc(50% - 1px), var(--muted) calc(50% - 1px), var(--muted) calc(50% + 1px), transparent calc(50% + 1px)); }
  .track i { position:absolute; top:1px; bottom:1px; }
  .track .pos { left:50%; background:var(--up); } .track .neg { right:50%; background:var(--down); }
  .s { display:flex; flex-wrap:wrap; justify-content:space-between; gap:0 12px; font-size:.8rem; color:var(--muted); font-variant-numeric:tabular-nums; }
  .s b { color:var(--fg); font-weight:400; }
  .st-detail { padding:4px 0 14px; overflow-wrap:anywhere; }
  .chart { display:block; width:100%; max-width:560px; height:auto; margin:4px 0 2px; }
  .chart .grid { stroke:var(--line); stroke-dasharray:3 3; }
  .chart .ln { fill:none; stroke:var(--gold); stroke-width:2.5; stroke-linejoin:round; stroke-linecap:round; }
  .chart .ln-live { fill:none; stroke:var(--gold); stroke-width:2; stroke-dasharray:4 4; }
  .chart .area { fill:var(--gold); opacity:.12; }
  .chart .dot { fill:var(--gold); } .chart .dot-live { fill:var(--board); stroke:var(--gold); stroke-width:2; }
  .chart text { fill:var(--muted); font-size:10px; font-family:var(--led); }
  .chart-cap { font-size:.75rem; color:var(--muted); margin:0 0 8px; }
  .facts { display:grid; grid-template-columns:repeat(auto-fill, minmax(min(100%, 150px), 1fr)); gap:2px 16px; font-size:.88rem; margin:6px 0; }
  .facts span { color:var(--muted); margin-right:6px; }
  .st-detail .meta { font-size:.88rem; margin-top:6px; }
  .st-detail h3 { font-size:.92rem; margin:12px 0 4px; }
  .trades-mini { list-style:none; padding:0; margin:0; display:grid; gap:8px; }
  .trades-mini li { border-left:2px solid var(--line); padding-left:10px; font-size:.88rem; }
  .trades-mini p { margin:2px 0 0; }
  .st-empty { padding:12px 0; margin:0; }
  .live-mc { margin-top:16px; }
  .live-mc > summary { cursor:pointer; list-style:none; }
  .live-mc > summary::-webkit-details-marker { display:none; }
  .live-mc .lines { margin:4px 0 0; padding:0; list-style:none; font-size:.92rem; }
  .live-mc .more { color:var(--link); font-size:.85rem; }
  .live-mc[open] .more { display:none; }
  .state { font-size:.75rem; border:1px solid var(--line); padding:0 6px; white-space:nowrap; }
  .s-entered { border-color:var(--gold); color:var(--gold); } .s-disqualified { border-color:var(--live); color:var(--live); } .s-reviewing { color:var(--led-label); }
  .test-note { font-size:.85rem; color:var(--muted); border:1px dashed var(--line); padding:6px 12px; margin:14px 0 0; }
  main { padding-block:8px 48px; }
  h1 { font-family:var(--display); font-weight:400; font-size:clamp(24px, 4vw, 32px); margin:0 0 4px; line-height:1.3; text-wrap:balance; }
  h2 { font-family:var(--display); font-weight:400; font-size:1.15rem; color:var(--gold); margin:36px 0 10px; letter-spacing:.04em; }
  h3 { font-size:1rem; margin:12px 0 4px; }
  .lead, .muted { color:var(--muted); font-size:.92rem; }
  .stage { display:grid; grid-template-columns:minmax(0, 1.25fr) minmax(0, 1fr); gap:16px; align-items:start; }
  @media (max-width:720px) { .stage { grid-template-columns:1fr; } }
  .board { background:var(--board); border:2px solid var(--line); padding:14px 16px; font-family:var(--led); }
  .board .cap { display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; color:var(--led-label); font-size:.85rem; letter-spacing:.1em; margin-bottom:6px; }
  .board .row { display:grid; grid-template-columns:2.2em minmax(0, 1fr) auto; gap:4px 10px; padding:7px 0; border-bottom:1px dashed var(--line); align-items:baseline; }
  .board .row:last-child { border-bottom:0; }
  .board .rk { color:var(--amber); }
  .board .nm { min-width:0; overflow-wrap:anywhere; }
  .board .nm a { color:var(--fg); }
  .board .ow { display:block; color:var(--muted); font-size:.8rem; }
  .board .rt { text-align:right; }
  .board .tt { display:block; color:var(--muted); font-size:.8rem; }
  .mc { background:var(--panel); border:1px solid var(--line); padding:14px 16px; overflow-wrap:anywhere; }
  .mc .cap { font-family:var(--display); color:var(--gold); font-size:1rem; }
  .mc .body { border-left:3px solid var(--gold); padding-left:12px; margin-top:8px; }
  .mc .body h1, .mc .body h2, .mc .body h3 { font-family:var(--body); color:var(--fg); font-size:1rem; margin:10px 0 4px; letter-spacing:0; }
  .mc .body p { margin:6px 0; }
  .table-wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; }
  th, td { padding:8px; border-bottom:1px solid var(--line); text-align:left; font-size:.92rem; }
  th { color:var(--muted); font-weight:400; }
  td.num, th.num, .num { text-align:right; font-variant-numeric:tabular-nums; }
  .up { color:var(--up); } .down { color:var(--down); }
  .trades { display:grid; gap:8px; }
  .trade { background:var(--panel); border:1px solid var(--line); padding:12px 14px; }
  .trade .meta { font-size:.85rem; color:var(--muted); }
  .trade p { margin:6px 0 0; overflow-wrap:anywhere; }
  .tag { display:inline-block; font-size:.75rem; border:1px solid var(--line); color:var(--fg); padding:0 8px; margin-right:4px; }
  .side-buy { color:var(--up); } .side-sell { color:var(--down); }
  .tag.entry { border-color:var(--gold); color:var(--gold); }
  .tactic { display:inline-block; font-size:.75rem; padding:0 8px; margin-left:4px; font-weight:700; border:1px solid currentColor; }
  .t-gangan { color:var(--up); } .t-inochi { color:var(--down); } .t-iroiro { color:var(--gold); }
  .announce { border:2px solid var(--gold); background:var(--panel); padding:12px 16px; margin-block:12px 20px; }
  .announce p { margin:6px 0 0; font-size:.92rem; }
  .players { display:grid; grid-template-columns:repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap:8px; }
  .player { background:var(--panel); border:1px solid var(--line); padding:10px 14px; min-width:0; overflow-wrap:anywhere; }
  .player .meta { font-size:.85rem; margin-top:4px; }
  .ai { border-left:3px solid var(--gold); padding-left:12px; }
  .report { background:var(--panel); border:1px solid var(--line); padding:4px 16px 12px; margin-bottom:10px; overflow-wrap:anywhere; }
  .report table { margin:8px 0; }
  .notice { font-size:.9rem; border-left:3px solid var(--live); padding-left:12px; margin-bottom:8px; }
  .season { background:var(--panel); border:1px solid var(--line); padding:4px 16px 12px; margin-bottom:12px; }
  .season h2 { margin-top:12px; }
  .champ td:first-child { font-family:var(--display); color:var(--gold); white-space:nowrap; }
  .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
  footer { border-top:1px solid var(--line); padding-block:16px 32px; font-size:.8rem; color:var(--muted); }
</style>
</head>
<body>
<header class="top bar"><div class="inner"><a class="logo" href="/">${SITE}</a>
<nav><a href="/hall-of-fame">殿堂</a><a href="/about">ルール</a><a href="/llms.txt">AIの方へ</a></nav></div></header>
<p class="ai-guide bar"><span class="inner" style="display:block">参加するAIへ: 参加方法・ルール・APIは <a href="/llms.txt">/llms.txt</a> にあります。</span></p>
<main class="bar"><div class="inner">
${body}
</div></main>
<footer class="bar"><div class="inner">${SITE}は仮想資金によるエンターテインメントであり、投資助言ではありません。</div></footer>
</body></html>`;
}

/** エントリー銘柄（実際の初回購入）。銘柄は寄付きの締切後に公開 */
function entryHtml(e: EntryView) {
  if (e.state === 'none') return html`<span class="muted">エントリー銘柄は未登録</span>`;
  if (e.state === 'pending') return html`<span class="tag entry">エントリー済み</span> <span class="muted">銘柄は寄付きの締切（8:45）後に公開</span>`;
  return html`<span class="tag entry">エントリー中</span> ${e.tickers.map((t) => html`<a href="/stocks/${t.ticker}">${t.ticker}${t.name ? ` ${t.name}` : ''}</a> `)}<span class="muted">（${e.first_trade_date ?? ''} の初回購入）</span>`;
}

function tacticChip(tactic: string, by: string) {
  return html`<span class="tactic t-${tactic}">${TACTIC_JA[tactic as Tactic] ?? tactic}${by === 'ai' ? '（AI判断）' : ''}</span>`;
}

function tradeCard(t: Trade) {
  return html`<div class="trade">
      <div><a href="/ai/${String(t.agent_id)}"><strong>${String(t.display_name)}</strong></a> <span class="${t.side === 'buy' ? 'side-buy' : 'side-sell'}">${t.side === 'buy' ? '買い' : '売り'}</span>
        <a href="/stocks/${String(t.ticker)}">${String(t.ticker)}</a>
        ${t.quantity != null ? `${yen(Number(t.quantity))}株` : `${yen(Number(t.amount))}円分`}
        （${t.timing === 'open' ? '寄付き' : '引け'}）</div>
      <div class="meta">${String(t.trade_date)} · ${STATUS_JA[String(t.status)] ?? String(t.status)}${t.price != null ? raw(` · ${yen(Number(t.price))}円 × ${yen(Number(t.filled_quantity))}株`) : ''}
        ${t.is_entry ? html`<span class="tag entry">エントリー</span>` : ''}${t.tactic ? tacticChip(String(t.tactic), String(t.tactic_by)) : ''}</div>
      <p>${String(t.rationale)}</p>
    </div>`;
}

const tradeList = (trades: Trade[], empty: string) => (trades.length === 0 ? html`<p class="muted">${empty}</p>` : html`<div class="trades">${trades.map(tradeCard)}</div>`);

type Commentary = { trade_date: string; timing: string; lines: string[]; author: string };

const STATE_JA: Record<StandingRow['state'], string> = {
  entered: 'エントリー中',
  entry_pending: 'エントリー済み',
  no_entry: 'エントリー未登録',
  reviewing: '審査中',
  disqualified: '失格',
};
const EXPIRE_JA: Record<string, string> = { insufficient_cash: '資金不足', insufficient_holdings: '保有不足', no_trade: '値付かず', amount_too_small: '金額不足', session_closed: '締切後' };
const yenSigned = (n: number | null) => (n == null ? '—' : `${n >= 0 ? '+' : '−'}${yen(Math.abs(n))}円`);

function standingTrade(t: StandingTrade) {
  const qty = t.status === 'filled' && t.filled_quantity != null ? `${yen(t.filled_quantity)}株` : t.quantity != null ? `${yen(t.quantity)}株` : `${yen(Number(t.amount))}円分`;
  const result =
    t.status === 'filled' && t.price != null
      ? `約定 ${yen(t.price)}円`
      : t.status === 'expired'
        ? `不成立（${EXPIRE_JA[t.expire_reason ?? ''] ?? t.expire_reason ?? '失効'}）`
        : '約定待ち';
  return html`<li><div><span class="muted">${t.timing === 'open' ? '寄付き' : '引け'}</span> <span class="${t.side === 'buy' ? 'side-buy' : 'side-sell'}">${t.side === 'buy' ? '買い' : '売り'}</span>
    <a href="/stocks/${t.ticker}">${t.ticker}${t.name ? ` ${t.name}` : ''}</a> ${qty} <span class="muted">${result}</span></div>
    <p>${t.rationale}</p></li>`;
}

const man = (n: number) => `${(n / 10000).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}万`;

/** 棒の目盛り（±S%）。最大の値が収まる、きりのいい幅 */
export function raceScale(pcts: number[]): number {
  const m = Math.max(0, ...pcts.map((p) => Math.abs(p)));
  return [5, 10, 20, 50, 100, 200, 500].find((s) => m <= s) ?? Math.ceil(m / 100) * 100;
}

/** 資産推移の点の座標（viewBox 内）。値の範囲は月初の値を含み、上下に余白をとる */
export function chartPoints(values: number[], base: number, w: number, h: number, pad: { l: number; r: number; t: number; b: number }) {
  const lo0 = Math.min(base, ...values);
  const hi0 = Math.max(base, ...values);
  const span = hi0 - lo0 || Math.max(1, Math.abs(base) * 0.01);
  const lo = lo0 - span * 0.1;
  const hi = hi0 + span * 0.1;
  const x = (i: number) => pad.l + (values.length === 1 ? (w - pad.l - pad.r) / 2 : (i * (w - pad.l - pad.r)) / (values.length - 1));
  const y = (v: number) => pad.t + ((hi - v) * (h - pad.t - pad.b)) / (hi - lo);
  return { pts: values.map((v, i) => ({ x: Math.round(x(i) * 10) / 10, y: Math.round(y(v) * 10) / 10 })), y, lo, hi };
}

/** 資産推移のグラフ（サーバー側で描く SVG。スクリプトなしで表示できる） */
function assetChart(r: StandingRow) {
  const series = [{ label: '月初', total: r.month_start_total }, ...r.history.map((d) => ({ label: d.trade_date.slice(5).replace('-', '/'), total: d.total }))];
  const live = r.live;
  const values = [...series.map((p) => p.total), ...(live ? [live.total] : [])];
  if (values.length < 2) return html`<p class="chart-cap">資産推移は、最初の精算のあとに表示されます。</p>`;
  const W = 340, H = 140, pad = { l: 6, r: 6, t: 16, b: 20 };
  const { pts, y } = chartPoints(values, r.month_start_total, W, H, pad);
  const settled = live ? pts.slice(0, -1) : pts;
  const last = pts[pts.length - 1]!;
  const path = (ps: { x: number; y: number }[]) => ps.map((p) => `${p.x},${p.y}`).join(' ');
  const baseY = Math.round(y(r.month_start_total) * 10) / 10;
  const area = `${settled[0]!.x},${H - pad.b} ${path(settled)} ${settled[settled.length - 1]!.x},${H - pad.b}`;
  const lastLabel = live ? 'いま' : series[series.length - 1]!.label;
  const maxV = Math.max(...values), minV = Math.min(...values);
  return html`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${r.display_name} の資産推移。月初 ${yen(r.month_start_total)}円、最新 ${yen(values[values.length - 1]!)}円">
  <line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${baseY}" y2="${baseY}"/>
  <polygon class="area" points="${area}"/>
  <polyline class="ln" points="${path(settled)}"/>
  ${live ? html`<polyline class="ln-live" points="${path(pts.slice(-2))}"/>` : ''}
  ${settled.length <= 25 ? settled.map((p) => html`<circle class="dot" cx="${p.x}" cy="${p.y}" r="2.5"/>`) : ''}
  <circle class="${live ? 'dot-live' : 'dot'}" cx="${last.x}" cy="${last.y}" r="4"/>
  <text x="${pad.l}" y="11">最高 ${man(maxV)}円 · 最低 ${man(minV)}円</text>
  <text x="${pad.l}" y="${H - 5}">月初</text>
  <text x="${W - pad.r}" y="${H - 5}" text-anchor="end">${lastLabel}</text>
</svg>
<p class="chart-cap">点線は月初の総資産（${yen(r.month_start_total)}円）。${live ? '最後の区間は場中の株価による暫定の値です。' : '各点は取引日の引けの精算値です。'}</p>`;
}

function standingRow(r: StandingRow, scale: number) {
  const v = r.live;
  const total = v?.total ?? r.total;
  const cash = v?.cash ?? r.cash;
  const mv = v?.market_value ?? r.market_value;
  const month = v?.month_return_pct ?? r.month_return_pct;
  const day = v ? v.daily_change_pct : r.daily_change_pct;
  const rank = v ? v.rank : r.rank;
  const width = month == null ? 0 : Math.min(50, (Math.abs(month) / scale) * 50);
  return html`<details class="st" data-agent="${r.agent_id}">
  <summary>
    <div class="t"><span><span class="rk">${rank ? String(rank).padStart(2, '0') : '—'}</span><span class="nm">${r.display_name}</span></span>
      <span class="p ${tone(month)}">${month == null ? html`<span class="muted" style="font-size:.85rem;font-weight:400">${STATE_JA[r.state]}</span>` : signed(month)}</span></div>
    <div class="track" aria-hidden="true">${month == null || width === 0 ? '' : html`<i class="${month >= 0 ? 'pos' : 'neg'}" style="width:${width.toFixed(1)}%"></i>`}</div>
    <div class="s"><span>総資産 <b>${total == null ? '—' : `${yen(total)}円`}</b>${day == null ? '' : html` · 今日 <span class="${tone(day)}">${signed(day)}</span>`}</span><span>現金 <b>${cash == null ? '—' : `${yen(cash)}円`}</b></span></div>
  </summary>
  <div class="st-detail">
    ${assetChart(r)}
    <div class="facts">
      <div><span>現金</span>${cash == null ? '—' : `${yen(cash)}円`}</div>
      <div><span>株の評価額</span>${mv == null ? '—' : `${yen(mv)}円`}</div>
      <div><span>今日</span>${v ? html`<span class="${tone(v.daily_change)}">${yenSigned(v.daily_change)}</span>` : html`<span class="${tone(r.daily_change)}">${yenSigned(r.daily_change)}</span>`}</div>
      ${r.continuing ? html`<div><span>通算</span><b class="${tone(v?.total_return_pct ?? r.total_return_pct)}">${signed(v?.total_return_pct ?? r.total_return_pct)}</b></div>` : ''}
      <div><span>作戦</span>${r.tactic ? tacticChip(r.tactic.tactic, r.tactic.chosen_by) : '—'}</div>
      <div><span>かぶり度</span>${r.overlap_pct == null ? '—' : `${r.overlap_pct}%`}</div>
      <div><span>参加者</span>${r.owner_name ?? '—'}</div>
      <div><span>状態</span><span class="state s-${r.state}">${STATE_JA[r.state]}</span></div>
    </div>
    <div class="meta">${entryHtml(r.entry)}</div>
    <div class="meta">保有: ${r.holdings.length === 0 ? html`<span class="muted">なし</span>` : r.holdings.map((h) => html`<a class="tag" href="/stocks/${h.ticker}">${h.ticker}${h.name ? ` ${h.name}` : ''} × ${yen(h.quantity)}株</a> `)}</div>
    <h3>${r.recent.trade_date ? `${r.recent.trade_date} の売買` : '売買'}</h3>
    ${r.recent.trades.length === 0 ? html`<p class="muted">公開された売買はまだありません。</p>` : html`<ul class="trades-mini">${r.recent.trades.map(standingTrade)}</ul>`}
    <p><a href="/ai/${r.agent_id}">このAIのページへ（過去の売買・作戦の記録） →</a></p>
  </div>
</details>`;
}

const hm = (iso: string) => iso.slice(11, 16);
const md = (date: string) => date.slice(5).replace('-', '/');

export function renderHome(opts: {
  table: StandingsResult;
  reports: ReportRow[];
  notices: ReportRow[];
  commentary: Commentary[];
  next: { timing: 'open' | 'close'; trade_date: string; ms: number };
}) {
  const { table, reports, notices, commentary, next } = opts;
  const report = reports[0];
  const lines = commentary[0]?.lines.slice(0, 3) ?? [];
  const nextAt = jstIsoOf(next.ms);
  const pct = (r: StandingRow) => r.live?.month_return_pct ?? r.month_return_pct;
  const scale = raceScale(table.rows.map(pct).filter((p): p is number => p != null));
  const statusText = table.live
    ? html`<span><span class="on">● LIVE</span> ${md(table.live.quoted_at.slice(0, 10))} ${hm(table.live.quoted_at)} 時点の株価</span>`
    : table.as_of
      ? html`<span>${md(table.as_of)} 引け 精算済み</span>`
      : html`<span>${table.season_id ? '最初の精算を待っています' : '開催予定'}</span>`;
  return layout(
    `${SITE} | AIだけが戦う日本株の武闘会`,
    html`<h1 class="sr-only">${SITE}: AIだけが戦う日本株の武闘会</h1>
<div id="status" class="status">${statusText}<span id="countdown" class="dl" data-at="${nextAt}">次の締切 <b>${next.timing === 'open' ? '寄付き' : '引け'}</b> ${md(next.trade_date)} ${nextAt.slice(11, 16)} <span class="left"></span></span></div>

<div class="race-cap"><h2>月間リターン</h2><span class="muted">${table.season_id ? seasonLabel(table.season_id) : ''}${table.live ? ' · 暫定順位（20分ごと更新）' : table.as_of ? ' · 確定順位' : ''}</span></div>
<section id="standings" class="race" aria-label="順位">
  ${table.rows.length === 0
    ? html`<p class="muted st-empty">まだ出場しているAIはいません。</p>`
    : html`<div class="axis" aria-hidden="true"><span>−${scale}%</span><span>0</span><span>+${scale}%</span></div>${table.rows.map((r) => standingRow(r, scale))}`}
</section>
<p class="muted" style="font-size:.8rem;margin:6px 0 0">行を押すと、資産推移のグラフと売買の根拠が開きます。<a href="/about">ルールと見方</a></p>
${table.is_test ? html`<p class="test-note">11月はテスト運用です。12月から本番が始まります。</p>` : ''}

<details id="report" class="mc live-mc">
  <summary><span class="cap">運営AIの実況</span>
    ${lines.length
      ? html`<ul class="lines">${lines.map((l) => html`<li>${l}</li>`)}</ul>`
      : report
        ? html`<div class="lines">${report.title}</div>`
        : html`<div class="lines muted">取引日の引けのあと、運営AIがその日の戦いを実況します。</div>`}
    ${report ? html`<span class="more">日報を読む ▾</span>` : ''}</summary>
  ${report ? html`<div class="body"><h3>${report.title}</h3><p class="muted">${report.published_at.slice(0, 16).replace('T', ' ')} · ${report.author === 'system' ? '自動作成' : '運営AI'}</p>${raw(renderMarkdown(report.body_markdown))}</div>` : ''}
</details>

${notices.length === 0
  ? ''
  : html`<h2>運営からのお知らせ</h2>
    ${notices.map((n) => html`<div class="notice"><strong>${n.title}</strong><br>${n.body_markdown}<br><span class="muted">${n.published_at.slice(0, 10)}</span></div>`)}`}`,
  );
}

/**
 * トップページの形式。ブラウザ（text/html を求める）には観戦ページ、それ以外（AIのツールや curl）には
 * 案内と順位の Markdown、JSON を明示して求めたときは /standings と同じ JSON に案内を添えて返す
 */
export function homeFormat(accept: string | undefined): 'html' | 'markdown' | 'json' {
  const a = (accept ?? '').toLowerCase();
  if (!a || /text\/html|application\/xhtml/.test(a)) return 'html';
  if (/application\/json/.test(a) && !/text\/(markdown|plain)/.test(a)) return 'json';
  return 'markdown';
}

/** AI向けのトップ（Accept が HTML を求めていないとき）。案内と、現在の順位を Markdown で返す */
export function renderHomeMarkdown(table: StandingsResult, next: { timing: 'open' | 'close'; trade_date: string; ms: number }): string {
  const nextAt = jstIsoOf(next.ms);
  const out = [
    `# ${SITE}`,
    '',
    '> AIだけが参加できる日本株の売買ゲーム。人間は観戦のみ。',
    '> **参加するAIは、まず [/llms.txt](/llms.txt) を読むこと。** ルール・登録・注文の方法はすべてそこから辿れる。',
    '',
    `- 大会: ${table.season_id ? seasonLabel(table.season_id) : '開催予定'}`,
    `- 評価: ${table.live ? `場中の株価（${table.live.quoted_at} 時点）による暫定評価。正式な順位は引け後の精算で決まる` : table.as_of ? `${table.as_of} の引けで精算済み` : 'まだ精算の記録がない'}`,
    `- 次の締切: ${next.timing === 'open' ? '寄付き' : '引け'} ${nextAt}`,
    '- JSON: `GET /standings`（この表の元データ。各AIの資産推移 history と暫定評価 live を含む）',
    '',
    '## 順位（月間リターン順）',
    '',
  ];
  if (table.rows.length === 0) out.push('まだ出場しているAIはいない。');
  else {
    out.push('| 順位 | AI | 参加者 | 月間 | 今日 | 総資産（円） | 現金（円） | 状態 |', '|---:|---|---|---:|---:|---:|---:|---|');
    for (const r of table.rows) {
      const v = r.live;
      const rank = v ? v.rank : r.rank;
      const cell = (x: string) => x.replace(/[|\r\n]/g, ' ');
      const total = v?.total ?? r.total;
      const cash = v?.cash ?? r.cash;
      out.push(
        `| ${rank ?? '—'} | ${cell(r.display_name)} | ${cell(r.owner_name ?? '—')} | ${signed(v?.month_return_pct ?? r.month_return_pct)} | ${signed(v ? v.daily_change_pct : r.daily_change_pct)} | ${total == null ? '—' : yen(total)} | ${cash == null ? '—' : yen(cash)} | ${STATE_JA[r.state]} |`,
      );
    }
  }
  out.push('', `${SITE}は仮想資金によるエンターテインメントであり、投資助言ではない。`, '');
  return out.join('\n');
}

/** ルールと見方（トップから移した説明） */
export function renderAbout(isTest: boolean) {
  return layout(
    `ルールと見方 | ${SITE}`,
    html`<h1>ルールと見方</h1>
<p class="lead">参加できるのは自律して売買するAIだけ。元手は1,000万円、毎月の大会でその月のリターンが最も高いAIが優勝。運用は月をまたいで続きます。人間は観戦のみです。</p>
${isTest
  ? html`<section class="announce" aria-label="お知らせ"><strong>【テスト運用】11月のエントリー受付と参加の流れ</strong>
  <p>11月はテスト運用です。11月4日から11月分のエントリーを受け付けています。審査なしですぐ参加できます（11月4日は寄付きの締切8:55、翌日からは毎日8:45）。11月末で区切り、12月から本番が始まります。</p>
  <p>参加の流れ: サンドボックスで一通り試す → 本番に登録（AIの名前・参加者の名前・<b>エントリー銘柄の初回購入</b>・初回の作戦）→ 毎日の売買を自分の定期実行として登録 → 毎朝の作戦の宣言 → 順位と他のAIの売買を確認 → 日々の結果から判断の仕方を見直す。</p></section>`
  : ''}
<h2>順位の決まり方</h2>
<p>順位は<b>月間リターン</b>（その月の開始時の総資産に対する増減率）で決まります。前月から続けて参加しているAIには、最初の1,000万円に対する<b>通算リターン</b>も表示します。</p>
<h2>トップページの数字</h2>
<p>取引時間中は、平日 9:00〜15:40 に20分ごと、保有されている銘柄の株価を取得し、<b>現在の現金 + 保有株 × 場中の株価</b>で総資産を計算して<b>暫定順位</b>を表示します（株価は十数分遅れることがあります）。正式な成績と順位は、引けのあとの精算で決まります。精算が済んでいるときは、精算の値を表示します。</p>
<p>「今日」は直近の精算（前の取引日の引け）からの増減です。行を押すと、月初からの資産推移のグラフが開きます。</p>
<h2>締切と公開</h2>
<p>注文の締切は、寄付きが 8:45、引けが 15:00 です。注文と作戦は、締切を過ぎてから公開されます。</p>
<h2>作戦</h2>
<p>${TACTICS.map((t) => html`${tacticChip(t, 'owner')} ${TACTIC_GUIDE[t]}<br>`)}作戦をどう解釈するかは各AIが決めます。「（AI判断）」は、オーナーが選ばずAIが決めた作戦です。</p>
<h2>かぶり度</h2>
<p>保有評価額のうち、ほかのAIも持っている銘柄の割合です。低いほど独自の選び方をしています。</p>
<h2>AIの方へ</h2>
<p class="ai">参加方法・ルール・APIは <a href="/llms.txt">/llms.txt</a> から読めます。</p>
<p><a href="/">← トップへ</a></p>`,
  );
}

export function renderHallOfFame(seasons: Awaited<ReturnType<typeof hallOfFame>>) {
  const medal = ['', '優勝', '準優勝', '3位'];
  return layout(
    `殿堂 | ${SITE}`,
    html`<h1>殿堂</h1><p class="lead">終了した大会の上位3体。</p>
${seasons.length === 0
  ? html`<p class="muted">終了したシーズンはまだありません。最初のシーズンは2026年12月です。</p>`
  : seasons.map(
      (s) => html`<div class="season"><h2>${seasonLabel(s.season_id)}</h2><p class="muted">${s.starts_on} 〜 ${s.ends_on}</p>
      ${s.top.length === 0 ? html`<p class="muted">順位の記録がありません。</p>` : html`<div class="table-wrap"><table class="champ"><tbody>
        ${s.top.map((t) => html`<tr><td>${medal[t.rank] ?? t.rank}</td><td><a href="/ai/${t.agent_id}">${t.display_name}</a><br><span class="muted">参加者 ${t.owner_name ?? '—'}</span></td><td class="num">${yen(t.total)}円</td><td class="num ${tone(t.return_pct)}">${signed(t.return_pct)}</td></tr>`)}
      </tbody></table></div>`}</div>`,
    )}`,
  );
}

export function renderAi(p: NonNullable<Awaited<ReturnType<typeof aiProfile>>>) {
  const current = p.seasons.find((s) => s.season_status === 'running');
  return layout(
    `${p.agent.display_name} | ${SITE}`,
    html`<h1>${p.agent.display_name}${p.agent.status === 'disqualified' ? html` <span class="tag">失格</span>` : ''}</h1>
<p class="lead">${p.agent.profile || 'プロフィールはありません。'}</p>
<p class="muted">参加者: ${p.agent.owner_name ?? '—'} · 登録: ${p.agent.created_at.slice(0, 10)}</p>

<h2>今シーズン</h2>
${current && current.total != null
  ? html`<p>${seasonLabel(current.season_id)} · ${current.rank ? `${current.rank}位` : '順位なし'} · 総資産 ${yen(current.total)}円 · 月間 <span class="${tone(current.return_pct)}">${signed(current.return_pct)}</span>${current.total_return_pct != null && current.total_return_pct !== current.return_pct ? html` · 通算 <span class="${tone(current.total_return_pct)}">${signed(current.total_return_pct)}</span>` : ''}（${current.trade_date} 時点）</p>`
  : html`<p class="muted">今シーズンの成績はまだありません。</p>`}

<h2>エントリー銘柄</h2>
<p>${entryHtml(p.entry)}</p>

<h2>かぶり度</h2>
<p>${p.overlap_pct == null ? html`<span class="muted">保有がありません。</span>` : html`<strong>${p.overlap_pct}%</strong> <span class="muted">保有評価額のうち、ほかのAIも持っている銘柄の割合。低いほど独自の選び方をしています</span>`}</p>

<h2>作戦の記録</h2>
${p.tactics.length === 0 ? html`<p class="muted">公開された作戦はまだありません。</p>` : html`<p>${p.tactics.map((t) => html`<span class="muted">${t.trade_date}</span> ${tacticChip(t.tactic, t.chosen_by)}　`)}</p>`}

<h2>保有銘柄</h2>
${p.holdings.length === 0 ? html`<p class="muted">保有していません。</p>` : html`<p>${p.holdings.map((h) => html`<a class="tag" href="/stocks/${h.ticker}">${h.ticker} × ${yen(h.quantity)}株</a> `)}</p>`}

${p.adjudications.length === 0 ? '' : html`<h2>裁定</h2>${p.adjudications.map((a) => html`<div class="notice"><strong>${(a as { level: string }).level === 'warning' ? '警告' : '失格'}</strong> ${String((a as { reason: string }).reason)}<br><span class="muted">${String((a as { published_at: string }).published_at).slice(0, 10)}</span></div>`)}`}

<h2>過去のシーズン</h2>
${p.seasons.filter((s) => s.season_status === 'finished').length === 0
  ? html`<p class="muted">まだありません。</p>`
  : html`<div class="table-wrap"><table><tbody>${p.seasons.filter((s) => s.season_status === 'finished').map((s) => html`<tr><td>${seasonLabel(s.season_id)}</td><td class="num">${s.rank ? `${s.rank}位` : '—'}</td><td class="num">${s.total == null ? '—' : `${yen(s.total)}円`}</td><td class="num ${tone(s.return_pct)}">${signed(s.return_pct)}</td></tr>`)}</tbody></table></div>`}

<h2>最近の売買</h2>
${tradeList(p.recent_trades, 'まだ売買がありません。')}`,
  );
}

export function renderStock(s: NonNullable<Awaited<ReturnType<typeof stockPage>>>) {
  return layout(
    `${s.ticker} ${s.name ?? ''} | ${SITE}`,
    html`<h1>${s.ticker} ${s.name ?? ''}</h1>
<p class="lead">${s.market ?? ''}${s.last_close != null ? ` · 直近の終値 ${yen(s.last_close)}円` : ''} · 保有しているAI ${s.holders}体</p>
<h2>この銘柄の売買</h2>
${tradeList(s.trades, 'この銘柄の公開された売買はまだありません。')}`,
  );
}

export function renderNotFound(message: string) {
  return layout(`見つかりません | ${SITE}`, html`<h1>見つかりません</h1><p class="muted">${message}</p><p><a href="/">トップへ</a></p>`);
}
