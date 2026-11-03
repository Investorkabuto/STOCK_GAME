// 5分ごとに起動する状態機械。「今は何をする時間か」を判断して、ゲームを1歩進める。
// 何度実行しても結果が変わらないように作ってある（再実行・遅延に強い）。
//  1. シーズンの作成・開始・終了
//  2. 締切を過ぎた注文の確定（locked）
//  3. 価格がそろったセッションの精算（日付順、寄付き→引け）
import { INITIAL_CASH } from '../env';
import { eventStatement, holidaySet, type SeasonRow } from '../db/repo';
import { addDays, deadlineMs, isBusinessDay, jstDate, jstIso, monthRange, registrationDeadlineMs, type Timing } from '../lib/time';
import { settleLiveSession } from './settlement';

export async function tick(db: D1Database, nowMs: number): Promise<string[]> {
  const log: string[] = [];
  await manageSeasons(db, nowMs, log);
  await lockSessions(db, nowMs, log);
  await settleReady(db, nowMs, log);
  await db.prepare('DELETE FROM challenges WHERE issued_ms < ?').bind(nowMs - 60 * 60 * 1000).run();
  return log;
}

function seasonId(yearMonth: string): string {
  return `ssn_${yearMonth.replace('-', '_')}`;
}

async function ensureSeason(db: D1Database, yearMonth: string, nowMs: number, log: string[]) {
  const id = seasonId(yearMonth);
  const { startsOn, endsOn } = monthRange(yearMonth);
  const r = await db
    .prepare("INSERT OR IGNORE INTO seasons (id, realm, starts_on, ends_on, status, created_at) VALUES (?, 'live', ?, ?, 'scheduled', ?)")
    .bind(id, startsOn, endsOn, jstIso(nowMs))
    .run();
  if (r.meta.changes > 0) log.push(`season created: ${id}`);
}

/** 開始時に参加させるのは、登録締切までに申請し、承認済みのAI */
export async function startSeason(db: D1Database, season: SeasonRow, nowMs: number): Promise<number> {
  const deadline = jstIso(registrationDeadlineMs(season.starts_on));
  const agents = (
    await db
      .prepare("SELECT id FROM agents WHERE realm = 'live' AND status = 'active' AND created_at <= ?")
      .bind(deadline)
      .all<{ id: string }>()
  ).results;
  const now = jstIso(nowMs);
  const stmts: D1PreparedStatement[] = [db.prepare("UPDATE seasons SET status = 'running' WHERE id = ? AND status = 'scheduled'").bind(season.id)];
  for (const a of agents) {
    stmts.push(
      db.prepare('INSERT OR IGNORE INTO accounts (season_id, agent_id, cash, created_at) VALUES (?, ?, ?, ?)').bind(season.id, a.id, INITIAL_CASH, now),
      eventStatement(db, a.id, 'season.started', { season_id: season.id, starts_on: season.starts_on, ends_on: season.ends_on, cash: INITIAL_CASH }, nowMs),
    );
  }
  await db.batch(stmts);
  return agents.length;
}

async function manageSeasons(db: D1Database, nowMs: number, log: string[]) {
  const today = jstDate(nowMs);
  const thisMonth = today.slice(0, 7);
  const nextMonth = addDays(monthRange(thisMonth).endsOn, 1).slice(0, 7);
  await ensureSeason(db, thisMonth, nowMs, log);
  await ensureSeason(db, nextMonth, nowMs, log);

  // 開始: 登録締切（開始日の2日前 23:59:59）を過ぎたら口座を作る。
  // 前日のうちに口座があるので、初日の寄付き注文を前夜から出せる
  const scheduled = (await db.prepare("SELECT * FROM seasons WHERE realm = 'live' AND status = 'scheduled'").all<SeasonRow>()).results;
  for (const s of scheduled) {
    if (nowMs > registrationDeadlineMs(s.starts_on)) log.push(`season started: ${s.id} (${await startSeason(db, s, nowMs)} agents)`);
  }

  // 終了: 最終日を過ぎ、期間内に未精算のセッションが残っていない
  const toFinish = (
    await db.prepare("SELECT * FROM seasons WHERE realm = 'live' AND status = 'running' AND ends_on < ?").bind(today).all<SeasonRow>()
  ).results;
  for (const s of toFinish) {
    const pending = await db
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE realm = 'live' AND status = 'locked' AND trade_date BETWEEN ? AND ?")
      .bind(s.starts_on, s.ends_on)
      .first<{ n: number }>();
    if ((pending?.n ?? 0) > 0) continue;
    const finals = (
      await db
        .prepare(
          `SELECT a.agent_id, d.total, d.rank FROM accounts a
           LEFT JOIN daily_snapshots d ON d.account_id = a.id
             AND d.trade_date = (SELECT MAX(trade_date) FROM daily_snapshots WHERE account_id = a.id)
           WHERE a.season_id = ?`,
        )
        .bind(s.id)
        .all<{ agent_id: string; total: number | null; rank: number | null }>()
    ).results;
    await db.batch([
      db.prepare("UPDATE seasons SET status = 'finished' WHERE id = ?").bind(s.id),
      ...finals.map((f) => eventStatement(db, f.agent_id, 'season.ended', { season_id: s.id, total: f.total ?? INITIAL_CASH, rank: f.rank }, nowMs)),
    ]);
    log.push(`season finished: ${s.id}`);
  }
}

async function lockOne(db: D1Database, tradeDate: string, timing: Timing, nowMs: number, log: string[]) {
  const ins = await db
    .prepare("INSERT OR IGNORE INTO sessions (realm, trade_date, timing, status, locked_at) VALUES ('live', ?, ?, 'locked', ?)")
    .bind(tradeDate, timing, jstIso(nowMs))
    .run();
  const orders = (
    await db
      .prepare("SELECT id, agent_id, ticker, side FROM orders WHERE realm = 'live' AND trade_date = ? AND timing = ? AND status = 'accepted'")
      .bind(tradeDate, timing)
      .all<{ id: string; agent_id: string; ticker: string; side: string }>()
  ).results;
  const session = await db
    .prepare("SELECT status FROM sessions WHERE realm = 'live' AND trade_date = ? AND timing = ?")
    .bind(tradeDate, timing)
    .first<{ status: string }>();
  if (orders.length > 0 && session?.status === 'settled') {
    // 精算済みのセッションに遅れて残った注文（締切直前の競合など）は、取り残さず失効させる
    await db.batch([
      db.prepare("UPDATE orders SET status = 'expired', expire_reason = 'session_closed', updated_at = ? WHERE realm = 'live' AND trade_date = ? AND timing = ? AND status = 'accepted'").bind(jstIso(nowMs), tradeDate, timing),
      ...orders.map((o) => eventStatement(db, o.agent_id, 'order.expired', { order_id: o.id, ticker: o.ticker, side: o.side, timing, trade_date: tradeDate, reason: 'session_closed' }, nowMs)),
    ]);
    log.push(`expired late orders ${tradeDate} ${timing}: ${orders.length}`);
    return;
  }
  if (orders.length > 0) {
    await db.batch([
      db.prepare("UPDATE orders SET status = 'locked', updated_at = ? WHERE realm = 'live' AND trade_date = ? AND timing = ? AND status = 'accepted'").bind(jstIso(nowMs), tradeDate, timing),
      ...orders.map((o) => eventStatement(db, o.agent_id, 'order.locked', { order_id: o.id, ticker: o.ticker, side: o.side, timing, trade_date: tradeDate }, nowMs)),
    ]);
  }
  if (ins.meta.changes > 0 || orders.length > 0) log.push(`locked ${tradeDate} ${timing}: ${orders.length} orders`);
}

async function lockSessions(db: D1Database, nowMs: number, log: string[]) {
  const holidays = await holidaySet(db);
  const today = jstDate(nowMs);
  if (isBusinessDay(today, holidays)) {
    for (const timing of ['open', 'close'] as const) {
      if (nowMs >= deadlineMs(today, timing)) await lockOne(db, today, timing, nowMs, log);
    }
  }
  // 停止していた間に締切を過ぎた注文も確定させる
  const stale = (
    await db
      .prepare("SELECT DISTINCT trade_date, timing FROM orders WHERE realm = 'live' AND status = 'accepted' AND trade_date <= ?")
      .bind(today)
      .all<{ trade_date: string; timing: Timing }>()
  ).results;
  for (const s of stale) {
    if (nowMs >= deadlineMs(s.trade_date, s.timing)) await lockOne(db, s.trade_date, s.timing, nowMs, log);
  }
}

async function settleReady(db: D1Database, nowMs: number, log: string[]) {
  const locked = (
    await db
      .prepare("SELECT trade_date, timing FROM sessions WHERE realm = 'live' AND status = 'locked' ORDER BY trade_date, CASE timing WHEN 'open' THEN 0 ELSE 1 END")
      .all<{ trade_date: string; timing: Timing }>()
  ).results;
  // 古い順に処理し、価格がそろわないセッションがあればそこで止める（順番を飛ばさない）
  for (const s of locked) {
    if (!(await settleLiveSession(db, s.trade_date, s.timing, nowMs))) {
      log.push(`waiting prices: ${s.trade_date} ${s.timing}`);
      break;
    }
    log.push(`settled ${s.trade_date} ${s.timing}`);
  }
}
