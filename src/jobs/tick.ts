// 5分ごとに起動する状態機械。「今は何をする時間か」を判断して、ゲームを1歩進める。
// 何度実行しても結果が変わらないように作ってある（再実行・遅延に強い）。
//  1. シーズンの作成・開始・終了
//  2. 締切を過ぎた注文の確定（locked）
//  3. 価格がそろったセッションの精算（日付順、寄付き→引け）
import { INITIAL_CASH, isTestSeason, type Env } from '../env';
import { eventStatement, holidaySet, lastCloses, loadAccount, type SeasonRow } from '../db/repo';
import { marketValue } from '../lib/engine';
import { addDays, deadlineMs, isBusinessDay, jstDate, jstIso, monthRange, registrationDeadlineMs, type Timing } from '../lib/time';
import { settleLiveSession } from './settlement';
import { ensureSchema } from '../db/migrate';
import { deliverWebhooks } from './webhooks';
import { applyPendingActions } from './corporate';
import { placeEntries } from './entry';
import { notifyRulesChange } from './notify';
import { checkAlerts, commentaryTask, expireTasks, seasonReviewTask, tasksAfterClose } from '../operator/scheduler';

export async function tick(env: Env, nowMs: number): Promise<string[]> {
  const db = env.DB;
  const log: string[] = [];
  const migrated = await ensureSchema(db);
  if (migrated.length) log.push(`schema migrated: ${migrated.join(', ')}`);
  await manageSeasons(db, nowMs, log);
  log.push(...(await placeEntries(db, nowMs)));
  log.push(...(await notifyRulesChange(db, nowMs)));
  await lockSessions(db, nowMs, log);
  await settleReady(db, nowMs, log);
  log.push(...(await expireTasks(db, nowMs)));
  log.push(...(await checkAlerts(env, nowMs)));
  log.push(...(await deliverWebhooks(env, nowMs)));
  await db.prepare('DELETE FROM challenges WHERE issued_ms < ?').bind(nowMs - 60 * 60 * 1000).run();
  return log;
}

function seasonId(yearMonth: string): string {
  return `ssn_${yearMonth.replace('-', '_')}`;
}

async function ensureSeason(db: D1Database, yearMonth: string, nowMs: number, log: string[]) {
  const id = seasonId(yearMonth);
  const { startsOn, endsOn } = monthRange(yearMonth);
  // 前月が本番の大会なら、その資金と保有株を引き継ぐ。テスト運用の月からは引き継がない
  const prevId = seasonId(addDays(startsOn, -1).slice(0, 7));
  const prev = await db.prepare("SELECT id FROM seasons WHERE id = ? AND realm = 'live'").bind(prevId).first<{ id: string }>();
  const carryFrom = prev && !isTestSeason(prev.id) ? prev.id : null;
  const r = await db
    .prepare("INSERT OR IGNORE INTO seasons (id, realm, starts_on, ends_on, status, created_at, carry_from) VALUES (?, 'live', ?, ?, 'scheduled', ?, ?)")
    .bind(id, startsOn, endsOn, jstIso(nowMs), carryFrom)
    .run();
  if (r.meta.changes > 0) log.push(`season created: ${id}`);
}

/** 開始時に参加させるのは、登録締切までに申請し、承認済みのAI */
export async function startSeason(db: D1Database, season: SeasonRow, nowMs: number): Promise<number> {
  const deadline = jstIso(registrationDeadlineMs(season.starts_on));
  // 失格の効果は原則そのシーズンのみ。次シーズン以降の停止が決まっていない失格AIは、ここで復帰させる（決定F）
  await db
    .prepare(
      `UPDATE agents SET status = 'active' WHERE realm = 'live' AND status = 'disqualified'
       AND id NOT IN (SELECT agent_id FROM adjudications WHERE status = 'enforced' AND level = 'disqualification' AND ban_future_seasons = 1)`,
    )
    .run();
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
      eventStatement(
        db,
        a.id,
        'season.started',
        season.carry_from
          ? { season_id: season.id, starts_on: season.starts_on, ends_on: season.ends_on, carry_over: true, note: '前月の最終精算のあと、前月の資金と保有株をこの大会に引き継ぎます（イベント season.carried_over）。前月に参加していなければ1,000万円から始まります' }
          : { season_id: season.id, starts_on: season.starts_on, ends_on: season.ends_on, carry_over: false, cash: INITIAL_CASH },
        nowMs,
      ),
    );
  }
  await db.batch(stmts);
  return agents.length;
}

/**
 * 前月の最終精算のあと、前月の資金と保有株（取得額も）を新しい月の口座へ写す。
 * 新しい月の開始時の総資産（start_total）を、前月最終日の終値で評価した総資産にする。月間リターンの基準になる
 */
export async function carryOver(db: D1Database, prev: SeasonRow, next: SeasonRow, nowMs: number): Promise<number> {
  const pairs = (
    await db
      .prepare('SELECT n.id AS new_id, n.agent_id, p.id AS prev_id FROM accounts n JOIN accounts p ON p.agent_id = n.agent_id AND p.season_id = ? WHERE n.season_id = ?')
      .bind(prev.id, next.id)
      .all<{ new_id: number; agent_id: string; prev_id: number }>()
  ).results;
  const stmts: D1PreparedStatement[] = [];
  for (const p of pairs) {
    const state = await loadAccount(db, p.prev_id);
    const closes = await lastCloses(db, [...state.holdings.keys()], prev.ends_on);
    const total = state.cash + marketValue(state.holdings, (t) => closes.get(t));
    stmts.push(
      db.prepare('UPDATE accounts SET cash = ?, start_total = ?, carried_from = ? WHERE id = ?').bind(state.cash, total, p.prev_id, p.new_id),
      db.prepare('DELETE FROM holdings WHERE account_id = ?').bind(p.new_id),
      db.prepare('INSERT INTO holdings (account_id, ticker, quantity, cost) SELECT ?, ticker, quantity, cost FROM holdings WHERE account_id = ?').bind(p.new_id, p.prev_id),
      eventStatement(
        db,
        p.agent_id,
        'season.carried_over',
        {
          from_season_id: prev.id,
          season_id: next.id,
          cash: state.cash,
          holdings: [...state.holdings].map(([ticker, h]) => ({ ticker, quantity: h.quantity, cost: h.cost })),
          month_start_total: total,
        },
        nowMs,
      ),
    );
  }
  stmts.push(db.prepare('UPDATE seasons SET carried_at = ? WHERE id = ?').bind(jstIso(nowMs), next.id));
  await db.batch(stmts);
  return pairs.length;
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

  // テスト運用の月は途中参加できる。参加中（active）の本番AIで口座がまだないものに、1,000万円の口座を作る
  // （テスト運用の受付前に承認されたAIや、管理者・運営AIが後から承認したAIのため）
  const running = (await db.prepare("SELECT * FROM seasons WHERE realm = 'live' AND status = 'running' AND ends_on >= ?").bind(today).all<SeasonRow>()).results;
  for (const s of running.filter((x) => isTestSeason(x.id))) {
    const missing = (
      await db
        .prepare("SELECT id FROM agents WHERE realm = 'live' AND status = 'active' AND id NOT IN (SELECT agent_id FROM accounts WHERE season_id = ?)")
        .bind(s.id)
        .all<{ id: string }>()
    ).results;
    if (missing.length === 0) continue;
    await db.batch(
      missing.flatMap((a) => [
        db.prepare('INSERT OR IGNORE INTO accounts (season_id, agent_id, cash, created_at) VALUES (?, ?, ?, ?)').bind(s.id, a.id, INITIAL_CASH, jstIso(nowMs)),
        eventStatement(db, a.id, 'season.started', { season_id: s.id, starts_on: s.starts_on, ends_on: s.ends_on, carry_over: false, cash: INITIAL_CASH }, nowMs),
      ]),
    );
    log.push(`test season ${s.id}: joined ${missing.length} agents`);
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
    await seasonReviewTask(db, s, nowMs);
    log.push(`season finished: ${s.id}`);
    const next = await db.prepare("SELECT * FROM seasons WHERE realm = 'live' AND carry_from = ? AND carried_at IS NULL").bind(s.id).first<SeasonRow>();
    if (next) log.push(`carried over ${s.id} -> ${next.id}: ${await carryOver(db, s, next, nowMs)} accounts`);
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
  const holidays = await holidaySet(db);
  for (const s of locked) {
    // 前月からの引き継ぎが終わるまで、新しい月の精算はしない
    const waiting = await db
      .prepare("SELECT id FROM seasons WHERE realm = 'live' AND starts_on <= ? AND ends_on >= ? AND carry_from IS NOT NULL AND carried_at IS NULL")
      .bind(s.trade_date, s.trade_date)
      .first<{ id: string }>();
    if (waiting) {
      log.push(`waiting carry-over: ${waiting.id}`);
      break;
    }
    // 権利落ち日の配当・分割は、その日の精算より前に反映する
    log.push(...(await applyPendingActions(db, s.trade_date, nowMs)));
    if (!(await settleLiveSession(db, s.trade_date, s.timing, nowMs))) {
      log.push(`waiting prices: ${s.trade_date} ${s.timing}`);
      break;
    }
    log.push(`settled ${s.trade_date} ${s.timing}`);
    if (await commentaryTask(db, s.trade_date, s.timing, nowMs)) log.push(`commentary task: ${s.trade_date} ${s.timing}`);
    if (s.timing === 'close') log.push(`operator tasks: ${(await tasksAfterClose(db, s.trade_date, holidays, nowMs)).join(', ')}`);
  }
}
