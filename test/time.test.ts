import { describe, expect, it } from 'vitest';
import { jstDate, jstToMs, monthRange, nextEligibleTradeDate, registrationDeadlineMs, jstIso } from '../src/lib/time';

const H = new Set(['2026-11-03', '2026-11-23']);

describe('time', () => {
  it('JSTの日付', () => {
    expect(jstDate(Date.parse('2026-11-03T15:30:00Z'))).toBe('2026-11-04');
    expect(jstIso(Date.parse('2026-11-03T22:41:12Z'))).toBe('2026-11-04T07:41:12+09:00');
  });
  it('締切前なら当日、締切後は次の営業日', () => {
    expect(nextEligibleTradeDate(jstToMs('2026-11-04', 7, 59), 'open', H)).toBe('2026-11-04');
    expect(nextEligibleTradeDate(jstToMs('2026-11-04', 8, 0), 'open', H)).toBe('2026-11-05');
    expect(nextEligibleTradeDate(jstToMs('2026-11-04', 14, 59), 'close', H)).toBe('2026-11-04');
    expect(nextEligibleTradeDate(jstToMs('2026-11-06', 15, 0), 'close', H)).toBe('2026-11-09'); // 金曜→月曜
    expect(nextEligibleTradeDate(jstToMs('2026-11-02', 9, 0), 'open', H)).toBe('2026-11-04'); // 祝日をとばす
  });
  it('月の範囲と登録締切', () => {
    expect(monthRange('2026-12')).toEqual({ startsOn: '2026-12-01', endsOn: '2026-12-31' });
    expect(monthRange('2027-02').endsOn).toBe('2027-02-28');
    expect(jstIso(registrationDeadlineMs('2026-12-01'))).toBe('2026-11-29T23:59:59+09:00');
  });
});
