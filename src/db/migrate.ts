// 本番 D1 のスキーマを、アプリ自身が最新に揃える。
// 管理画面の Console に SQL を手で貼る運用をなくすため、定時処理の最初に実行する。
// どの文も「すでにあれば何もしない」形にしてあるので、何度実行しても、
// wrangler の migrations（ローカル開発用）で作った表と共存しても安全。

type Step = { kind: 'sql'; sql: string } | { kind: 'column'; table: string; column: string; type: string };

interface Migration {
  name: string;
  steps: Step[];
}

/** migrations/ の各ファイルと同じ内容。新しいマイグレーションを足すときは、ここにも追加する */
const MIGRATIONS: Migration[] = [
  {
    name: '0002_operator',
    steps: [
      { kind: 'column', table: 'agents', column: 'ip_prefix_hash', type: 'TEXT' },
      { kind: 'column', table: 'orders', column: 'ip_prefix_hash', type: 'TEXT' },
      { kind: 'sql', sql: "CREATE TABLE IF NOT EXISTS operator_tasks (id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('registration_review', 'fraud_check', 'report_daily', 'report_weekly', 'season_review', 'appeal_review')), status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'expired')), subject_id TEXT NOT NULL, payload_json TEXT NOT NULL, due_at TEXT NOT NULL, expires_at TEXT, created_at TEXT NOT NULL, done_at TEXT, result_json TEXT, result_reason TEXT, idempotency_key TEXT, response_json TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT)" },
      { kind: 'sql', sql: 'CREATE INDEX IF NOT EXISTS operator_tasks_status ON operator_tasks (status, due_at)' },
      { kind: 'sql', sql: 'CREATE UNIQUE INDEX IF NOT EXISTS operator_tasks_subject ON operator_tasks (type, subject_id)' },
      { kind: 'sql', sql: 'CREATE TABLE IF NOT EXISTS operator_tokens (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT, last_seen_at TEXT)' },
      { kind: 'sql', sql: "CREATE TABLE IF NOT EXISTS adjudications (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents (id), season_id TEXT, level TEXT NOT NULL CHECK (level IN ('warning', 'disqualification')), status TEXT NOT NULL CHECK (status IN ('published', 'pending_review', 'enforced', 'rejected', 'withdrawn')), reason TEXT NOT NULL, evidence_json TEXT NOT NULL, source_task_id TEXT, ban_future_seasons INTEGER NOT NULL DEFAULT 0, decided_by TEXT, decided_at TEXT, published_at TEXT, created_at TEXT NOT NULL)" },
      { kind: 'sql', sql: 'CREATE INDEX IF NOT EXISTS adjudications_agent ON adjudications (agent_id, created_at)' },
      { kind: 'sql', sql: "CREATE TABLE IF NOT EXISTS appeals (id TEXT PRIMARY KEY, adjudication_id TEXT NOT NULL UNIQUE REFERENCES adjudications (id), agent_id TEXT NOT NULL REFERENCES agents (id), statement TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('reviewing', 'pending_admin', 'decided')), finding TEXT CHECK (finding IN ('uphold', 'overturn', 'downgrade')), operator_reason TEXT, task_id TEXT, created_at TEXT NOT NULL, decided_at TEXT)" },
      { kind: 'sql', sql: "CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('daily', 'daily_auto', 'weekly', 'season_review', 'season_announcement', 'adjudication')), subject TEXT NOT NULL, title TEXT NOT NULL, body_markdown TEXT NOT NULL, author TEXT NOT NULL, source_task_id TEXT, status TEXT NOT NULL CHECK (status IN ('published', 'withdrawn')), published_at TEXT NOT NULL, withdrawn_at TEXT, withdraw_note TEXT)" },
      { kind: 'sql', sql: 'CREATE INDEX IF NOT EXISTS reports_published ON reports (status, published_at)' },
      { kind: 'sql', sql: "CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL CHECK (actor IN ('operator', 'admin', 'system')), action TEXT NOT NULL, target TEXT, detail_json TEXT, created_at TEXT NOT NULL, created_ms INTEGER NOT NULL)" },
      { kind: 'sql', sql: 'CREATE INDEX IF NOT EXISTS audit_log_actor ON audit_log (actor, created_ms)' },
      { kind: 'sql', sql: 'CREATE TABLE IF NOT EXISTS alerts (key TEXT PRIMARY KEY, title TEXT NOT NULL, issue_number INTEGER, opened_at TEXT NOT NULL)' },
    ],
  },
  {
    name: '0003_webhook',
    steps: [
      { kind: 'sql', sql: 'CREATE TABLE IF NOT EXISTS webhook_endpoints (agent_id TEXT PRIMARY KEY REFERENCES agents (id), url TEXT NOT NULL, secret TEXT NOT NULL, last_event_id INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0, next_attempt_ms INTEGER NOT NULL DEFAULT 0, last_status TEXT, last_attempt_at TEXT, disabled_at TEXT, created_at TEXT NOT NULL)' },
    ],
  },
  {
    name: '0004_corporate_actions',
    steps: [
      { kind: 'sql', sql: "CREATE TABLE IF NOT EXISTS corporate_actions (ticker TEXT NOT NULL, ex_date TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('split', 'dividend')), ratio REAL, amount REAL, status TEXT NOT NULL CHECK (status IN ('pending', 'applied')), created_at TEXT NOT NULL, applied_at TEXT, PRIMARY KEY (ticker, ex_date, kind))" },
    ],
  },
];

async function hasColumn(db: D1Database, table: string, column: string): Promise<boolean> {
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('${table}') WHERE name = ?`).bind(column).first<{ n: number }>();
  return (r?.n ?? 0) > 0;
}

/** 未適用のマイグレーションを適用し、適用したものの名前を返す */
export async function ensureSchema(db: D1Database): Promise<string[]> {
  await db.prepare('CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)').run();
  const done = new Set((await db.prepare('SELECT name FROM app_migrations').all<{ name: string }>()).results.map((r) => r.name));
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    for (const step of m.steps) {
      if (step.kind === 'column') {
        if (!(await hasColumn(db, step.table, step.column))) await db.prepare(`ALTER TABLE ${step.table} ADD COLUMN ${step.column} ${step.type}`).run();
      } else {
        await db.prepare(step.sql).run();
      }
    }
    await db.prepare('INSERT OR IGNORE INTO app_migrations (name, applied_at) VALUES (?, ?)').bind(m.name, new Date().toISOString()).run();
    applied.push(m.name);
  }
  return applied;
}
