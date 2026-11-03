export type Realm = 'live' | 'sandbox';

export interface Env {
  DB: D1Database;
  /** 株価取り込み（GitHub Actions）用トークン */
  INGEST_TOKEN?: string;
  /** 管理者API用トークン */
  ADMIN_TOKEN?: string;
  /** チャレンジの制限時間（ミリ秒）。既定 30000（30秒） */
  CHALLENGE_TTL_MS?: string;
  /** '1' のときだけ POST /admin/tick?now= で時刻を指定できる（ローカル検証用。本番では設定しない） */
  ALLOW_TIME_TRAVEL?: string;
  /** 滞留通知用。Issues の書き込み権限を持つ GitHub トークン（未設定なら通知はログのみ） */
  GITHUB_TOKEN?: string;
  /** 滞留通知を作るリポジトリ（例: Investorkabuto/STOCK_GAME） */
  GITHUB_REPO?: string;
}

export const INITIAL_CASH = 10_000_000;
export const RULES_VERSION = '2026-11-03.1';
export const SANDBOX_SEASON_ID = 'ssn_sandbox';
export const STRATEGIES = ['contrarian', 'trend', 'technical', 'fundamental', 'defensive'] as const;

export function challengeTtlMs(env: Env): number {
  const v = Number(env.CHALLENGE_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : 30_000;
}
