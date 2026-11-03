// 定時処理から呼ぶ運営まわりの処理: タスクの作成・失効、簡易版日報、滞留通知（GitHub Issue）
import type { Env } from '../env';
import type { SeasonRow } from '../db/repo';
import { newId } from '../lib/crypto';
import { addDays, jstIso, nextBusinessDay } from '../lib/time';
import { auditStatement, createTaskStatement, REPORT_DAILY_EXPIRES_MS, TASK_DUE_MS, type TaskType } from './core';

/** ISO 8601 の週番号（例: 2026-W45） */
export function isoWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // 月曜=0
  d.setUTCDate(d.getUTCDate() - day + 3); // その週の木曜
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** 引けの精算が終わったら、不正検知・日報（週の最終営業日なら週報も）のタスクを積む */
export async function tasksAfterClose(db: D1Database, tradeDate: string, holidays: ReadonlySet<string>, nowMs: number): Promise<string[]> {
  const dataUrl = `/operator/data/daily/${tradeDate}`;
  const stmts = [
    createTaskStatement(db, 'fraud_check', tradeDate, { date: tradeDate, data_url: dataUrl }, nowMs),
    createTaskStatement(db, 'report_daily', tradeDate, { date: tradeDate, data_url: dataUrl }, nowMs, { expiresMs: nowMs + REPORT_DAILY_EXPIRES_MS }),
  ];
  const week = isoWeek(tradeDate);
  const created = ['fraud_check', 'report_daily'];
  if (isoWeek(nextBusinessDay(tradeDate, holidays)) !== week) {
    const dates = (
      await db.prepare("SELECT trade_date FROM sessions WHERE realm = 'live' AND timing = 'close' AND status = 'settled' AND trade_date BETWEEN ? AND ? ORDER BY trade_date").bind(addDays(tradeDate, -6), tradeDate).all<{ trade_date: string }>()
    ).results.map((r) => r.trade_date).filter((d) => isoWeek(d) === week);
    stmts.push(createTaskStatement(db, 'report_weekly', week, { week, dates, data_urls: dates.map((d) => `/operator/data/daily/${d}`) }, nowMs));
    created.push('report_weekly');
  }
  await db.batch(stmts);
  return created;
}

/** シーズンの最終評価が終わったら、総評と次シーズンの告知のタスクを積む */
export async function seasonReviewTask(db: D1Database, season: SeasonRow, nowMs: number) {
  const standings = (
    await db
      .prepare(
        `SELECT d.rank, g.display_name, a.agent_id, d.total FROM accounts a JOIN agents g ON g.id = a.agent_id
         JOIN daily_snapshots d ON d.account_id = a.id AND d.trade_date = (SELECT MAX(trade_date) FROM daily_snapshots WHERE account_id = a.id)
         WHERE a.season_id = ? ORDER BY CASE WHEN d.rank = 0 THEN 1 ELSE 0 END, d.rank`,
      )
      .bind(season.id)
      .all()
  ).results;
  const next = await db.prepare("SELECT id, starts_on FROM seasons WHERE realm = 'live' AND starts_on > ? ORDER BY starts_on LIMIT 1").bind(season.ends_on).first<{ id: string; starts_on: string }>();
  await createTaskStatement(db, 'season_review', season.id, { season_id: season.id, final_standings: standings, next_season: next ? { id: next.id, starts_at: `${next.starts_on}T00:00:00+09:00` } : null }, nowMs).run();
}

/** 日報タスクの失効。失効した日は、プログラムが簡易版日報を公開する */
export async function expireTasks(db: D1Database, nowMs: number): Promise<string[]> {
  const due = (
    await db.prepare("SELECT id, subject_id FROM operator_tasks WHERE type = 'report_daily' AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?").bind(jstIso(nowMs)).all<{ id: string; subject_id: string }>()
  ).results;
  const log: string[] = [];
  for (const t of due) {
    const body = await autoDailyReport(db, t.subject_id);
    await db.batch([
      db.prepare("UPDATE operator_tasks SET status = 'expired' WHERE id = ? AND status = 'pending'").bind(t.id),
      db
        .prepare("INSERT INTO reports (id, kind, subject, title, body_markdown, author, source_task_id, status, published_at) VALUES (?, 'daily_auto', ?, ?, ?, 'system', ?, 'published', ?)")
        .bind(newId('rpt', nowMs), t.subject_id, `${t.subject_id} の結果（簡易版）`, body, t.id, jstIso(nowMs)),
      auditStatement(db, 'system', 'task.expired', t.id, { type: 'report_daily', subject: t.subject_id }, nowMs),
    ]);
    log.push(`report_daily expired: ${t.subject_id}`);
  }
  return log;
}

async function autoDailyReport(db: D1Database, date: string): Promise<string> {
  const top = (
    await db
      .prepare('SELECT d.rank, g.display_name, d.total FROM daily_snapshots d JOIN accounts a ON a.id = d.account_id JOIN agents g ON g.id = a.agent_id WHERE d.trade_date = ? AND d.rank > 0 ORDER BY d.rank LIMIT 10')
      .bind(date)
      .all<{ rank: number; display_name: string; total: number }>()
  ).results;
  const tickers = (
    await db
      .prepare("SELECT ticker, COUNT(*) AS n FROM orders WHERE realm = 'live' AND trade_date = ? AND status = 'filled' GROUP BY ticker ORDER BY n DESC, ticker LIMIT 5")
      .bind(date)
      .all<{ ticker: string; n: number }>()
  ).results;
  const lines = [`運営AIの日報が期限内に届かなかったため、プログラムが作成した簡易版です。`, '', '## 順位（上位10）', ''];
  if (top.length) {
    lines.push('| 順位 | AI | 総資産（円） |', '| --- | --- | --- |', ...top.map((r) => `| ${r.rank} | ${r.display_name.replace(/\|/g, '｜')} | ${r.total.toLocaleString('ja-JP')} |`));
  } else lines.push('この日の順位はありません。');
  lines.push('', '## よく売買された銘柄', '');
  lines.push(...(tickers.length ? tickers.map((t) => `- ${t.ticker}: ${t.n}件`) : ['約定した売買はありません。']));
  return lines.join('\n');
}

// ---------------------------------------------------------------- 滞留通知

const HOUR = 60 * 60 * 1000;
const STALE_THRESHOLDS: Partial<Record<TaskType, number>> = {
  registration_review: 24 * HOUR,
  report_daily: 24 * HOUR,
  fraud_check: 48 * HOUR,
};
const OPERATOR_SILENT_MS = 36 * HOUR;
const ADJUDICATION_REMIND_MS = 72 * HOUR;

interface Condition {
  key: string;
  title: string;
  body: string;
}

async function currentConditions(db: D1Database, nowMs: number): Promise<Condition[]> {
  const out: Condition[] = [];
  for (const [type, ms] of Object.entries(STALE_THRESHOLDS) as [TaskType, number][]) {
    // 期限（due_at）は作成時刻 + 期限。滞留は「作成から閾値を超えた」で判定する
    const createdBefore = jstIso(nowMs - ms);
    const r = await db.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM operator_tasks WHERE type = ? AND status = 'pending' AND created_at <= ?").bind(type, createdBefore).first<{ n: number; oldest: string | null }>();
    if ((r?.n ?? 0) > 0) {
      out.push({ key: `stale:${type}`, title: `運営タスクの滞留: ${type}（${r!.n}件）`, body: `${type} のタスクが ${ms / HOUR} 時間以上処理されていません（最古: ${r!.oldest}）。運営AI（もち）の定期実行を確認してください。` });
    }
  }
  const tokens = await db.prepare('SELECT COUNT(*) AS n, MAX(COALESCE(last_seen_at, created_at)) AS last FROM operator_tokens WHERE revoked_at IS NULL').first<{ n: number; last: string | null }>();
  if ((tokens?.n ?? 0) > 0 && tokens!.last && nowMs - Date.parse(tokens!.last) > OPERATOR_SILENT_MS) {
    out.push({ key: 'operator_silent', title: '運営AIからの応答が36時間以上ありません', body: `運営トークンの最終呼び出し: ${tokens!.last}。運営AI（もち）が止まっていないか確認してください。` });
  }
  const adj = await db.prepare("SELECT COUNT(*) AS n FROM adjudications WHERE status = 'pending_review' AND created_at <= ?").bind(jstIso(nowMs - ADJUDICATION_REMIND_MS)).first<{ n: number }>();
  if ((adj?.n ?? 0) > 0) {
    out.push({ key: 'adjudication_pending', title: `失格案が承認待ちのままです（${adj!.n}件）`, body: '`GET /admin/adjudications` で確認し、`POST /admin/adjudications/{id}/approve` または `reject` で判断してください。' });
  }
  return out;
}

async function github(env: Env, method: string, path: string, body?: unknown): Promise<Record<string, unknown> | null> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return null;
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'stock-game-worker', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    console.error(`GitHub API ${method} ${path}: ${r.status} ${await r.text()}`);
    return null;
  }
  return (await r.json()) as Record<string, unknown>;
}

/** 条件が新しく成立したら Issue を開き、解消したらコメントして閉じる。開いている間は重複して作らない */
export async function checkAlerts(env: Env, nowMs: number): Promise<string[]> {
  const db = env.DB;
  const log: string[] = [];
  const conds = await currentConditions(db, nowMs);
  const open = new Map((await db.prepare('SELECT key, issue_number FROM alerts').all<{ key: string; issue_number: number | null }>()).results.map((a) => [a.key, a.issue_number]));
  for (const c of conds) {
    if (open.has(c.key)) continue;
    const issue = await github(env, 'POST', '/issues', { title: `[operator-alert] ${c.title}`, body: c.body, labels: ['operator-alert'] });
    await db.prepare('INSERT OR REPLACE INTO alerts (key, title, issue_number, opened_at) VALUES (?, ?, ?, ?)').bind(c.key, c.title, (issue?.number as number | undefined) ?? null, jstIso(nowMs)).run();
    log.push(`alert opened: ${c.key}${issue ? ` (#${issue.number})` : ' (GitHub未設定)'}`);
  }
  const active = new Set(conds.map((c) => c.key));
  for (const [key, num] of open) {
    if (active.has(key)) continue;
    if (num) {
      await github(env, 'POST', `/issues/${num}/comments`, { body: `解消しました（${jstIso(nowMs)}）。` });
      await github(env, 'PATCH', `/issues/${num}`, { state: 'closed' });
    }
    await db.prepare('DELETE FROM alerts WHERE key = ?').bind(key).run();
    log.push(`alert resolved: ${key}`);
  }
  return log;
}

export { TASK_DUE_MS };
