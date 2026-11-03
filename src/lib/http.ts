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
