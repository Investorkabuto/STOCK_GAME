// 日本時間（JST, UTC+9）の日付・締切計算。サマータイムはないので固定オフセットで扱う。

export type Timing = 'open' | 'close';

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 締切（日本時間の時・分） */
export const DEADLINES: Record<Timing, { hour: number; minute: number }> = {
  open: { hour: 8, minute: 45 },
  close: { hour: 15, minute: 0 },
};

/** epoch ms → 日本時間の 'YYYY-MM-DD' */
export function jstDate(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** epoch ms → 日本時間の ISO 8601 文字列（例: 2026-11-04T07:41:12+09:00） */
export function jstIso(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 19) + '+09:00';
}

/** 'YYYY-MM-DD' の日本時間 hh:mm を epoch ms に */
export function jstToMs(date: string, hour: number, minute: number): number {
  return Date.parse(`${date}T00:00:00Z`) - JST_OFFSET_MS + (hour * 60 + minute) * 60 * 1000;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function isWeekend(date: string): boolean {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

export function isBusinessDay(date: string, holidays: ReadonlySet<string>): boolean {
  return !isWeekend(date) && !holidays.has(date);
}

export function nextBusinessDay(date: string, holidays: ReadonlySet<string>): string {
  let d = addDays(date, 1);
  while (!isBusinessDay(d, holidays)) d = addDays(d, 1);
  return d;
}

/** 特定の日だけ締切を変える（例: テスト運用の初日） */
export const DEADLINE_OVERRIDES: Record<string, Partial<Record<Timing, { hour: number; minute: number }>>> = {
  '2026-11-04': { open: { hour: 8, minute: 55 } },
};

export function deadlineMs(date: string, timing: Timing): number {
  const { hour, minute } = DEADLINE_OVERRIDES[date]?.[timing] ?? DEADLINES[timing];
  return jstToMs(date, hour, minute);
}

/**
 * いま注文を出したときに対象となる取引日。
 * 当日が営業日で締切前なら当日、そうでなければ次の営業日。
 */
export function nextEligibleTradeDate(nowMs: number, timing: Timing, holidays: ReadonlySet<string>): string {
  const today = jstDate(nowMs);
  if (isBusinessDay(today, holidays) && nowMs < deadlineMs(today, timing)) return today;
  return nextBusinessDay(today, holidays);
}

/** その月の初日と末日 */
export function monthRange(yearMonth: string): { startsOn: string; endsOn: string } {
  const startsOn = `${yearMonth}-01`;
  const [y, m] = yearMonth.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { startsOn, endsOn: addDays(next, -1) };
}

/** 登録締切: シーズン開始日の2日前 23:59:59（日本時間） */
export function registrationDeadlineMs(seasonStartsOn: string): number {
  return jstToMs(addDays(seasonStartsOn, -1), 0, 0) - 1000;
}
