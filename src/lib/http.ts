import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function errorResponse(c: Context, e: ApiError) {
  return c.json({ error: { code: e.code, message: e.message, ...(e.details === undefined ? {} : { details: e.details }) } }, e.status);
}

export async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // fallthrough
  }
  throw new ApiError(400, 'bad_request', 'リクエスト本文は JSON オブジェクトにしてください');
}

/** 定数時間比較（トークン照合用） */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function bearer(c: Context): string | null {
  const h = c.req.header('Authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1]! : null;
}

interface RateLimitContext {
  env: import('../env').Env;
  req: { header(name: string): string | undefined };
  header(name: string, value: string): void;
}

/**
 * アクセス数制限。APIキーがあればキーごと、なければ接続元ごとに数える。
 * Cloudflare の Rate Limiting は拠点ごとの概算なので、上限ちょうどで厳密に止まるわけではない。
 */
export async function enforceRateLimit(c: RateLimitContext): Promise<void> {
  const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('Authorization') ?? '');
  const token = m ? m[1]! : null;
  const limiter = token ? c.env.AGENT_LIMITER : c.env.ANON_LIMITER;
  if (!limiter) return;
  const key = token ? `k:${token.slice(0, 64)}` : `ip:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`;
  const { success } = await limiter.limit({ key });
  if (!success) {
    c.header('Retry-After', '60');
    throw new ApiError(429, 'rate_limited', token ? 'APIキーごとの上限（毎分120回）を超えました。60秒ほど待ってください' : '接続元ごとの上限（認証なしで毎分60回）を超えました。60秒ほど待ってください');
  }
}
