// 配当・株式分割を、本番の参加中シーズンの口座に反映する
import { addDays, jstIso } from '../lib/time';
import { applyCorporateAction, type CorporateAction } from '../lib/corporate';
import { eventStatement, lastCloses, loadAccount, saveAccountStatements } from '../db/repo';

interface ActionRow extends CorporateAction {
  ex_date: string;
}

/** 権利落ち日が upToDate 以前で、未反映のものを反映する。精算の直前に呼ぶ */
export async function applyPendingActions(db: D1Database, upToDate: string, nowMs: number): Promise<string[]> {
  const actions = (
    await db
      .prepare("SELECT ticker, ex_date, kind, ratio, amount FROM corporate_actions WHERE status = 'pending' AND ex_date <= ? ORDER BY ex_date, kind DESC")
      .bind(upToDate)
      .all<ActionRow>()
  ).results;
  const log: string[] = [];
  for (const a of actions) {
    const holders = (
      await db
        .prepare(
          `SELECT a.id, a.agent_id FROM holdings h JOIN accounts a ON a.id = h.account_id JOIN seasons s ON s.id = a.season_id
           WHERE s.realm = 'live' AND s.status = 'running' AND h.ticker = ?`,
        )
        .bind(a.ticker)
        .all<{ id: number; agent_id: string }>()
    ).results;
    const close = (await lastCloses(db, [a.ticker], addDays(a.ex_date, -1))).get(a.ticker);
    const stmts: D1PreparedStatement[] = [];
    for (const h of holders) {
      const { account, effect } = applyCorporateAction(await loadAccount(db, h.id), a, close);
      if (!effect) continue;
      stmts.push(
        ...saveAccountStatements(db, h.id, account),
        eventStatement(db, h.agent_id, 'corporate_action.applied', { ...effect, ex_date: a.ex_date, ratio: a.ratio, amount_per_share: a.amount }, nowMs),
      );
    }
    stmts.push(
      db.prepare("UPDATE corporate_actions SET status = 'applied', applied_at = ? WHERE ticker = ? AND ex_date = ? AND kind = ?").bind(jstIso(nowMs), a.ticker, a.ex_date, a.kind),
    );
    await db.batch(stmts);
    log.push(`corporate action ${a.kind} ${a.ticker} ${a.ex_date}: ${holders.length} holders`);
  }
  return log;
}
