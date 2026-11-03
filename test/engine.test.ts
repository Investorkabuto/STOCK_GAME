import { describe, expect, it } from 'vitest';
import { marketValue, rankByTotal, settleSession, type AccountState, type EngineOrder, type PriceInfo } from '../src/lib/engine';

const acc = (cash: number, h: Record<string, [number, number]> = {}): AccountState => ({
  cash,
  holdings: new Map(Object.entries(h).map(([t, [quantity, cost]]) => [t, { quantity, cost }])),
});
const order = (id: string, side: 'buy' | 'sell', ticker: string, q: number | null, a: number | null, ms: number): EngineOrder =>
  ({ id, side, ticker, quantity: q, amount: a, receivedMs: ms });
const prices = (p: Record<string, number | null>) => (t: string): PriceInfo =>
  p[t] == null ? { status: 'no_trade' } : { status: 'ok', price: p[t]! };

describe('settleSession', () => {
  it('売りを先に処理し、その資金で買える', () => {
    const r = settleSession(acc(100_000, { '7203': [100, 250_000] }),
      [order('b1', 'buy', '6758', 100, null, 1), order('s1', 'sell', '7203', 100, null, 2)],
      prices({ '7203': 3000, '6758': 3500 }));
    expect(r.results.map((x) => x.status)).toEqual(['filled', 'filled']);
    expect(r.account.cash).toBe(100_000 + 300_000 - 350_000);
    expect(r.account.holdings.has('7203')).toBe(false);
  });

  it('資金不足の買いは丸ごと失効し、後続は処理される', () => {
    const r = settleSession(acc(500_000),
      [order('b1', 'buy', 'AAAA', 200, null, 1), order('b2', 'buy', 'BBBB', 100, null, 2)],
      prices({ AAAA: 3000, BBBB: 1000 }));
    expect(r.results).toEqual([
      { orderId: 'b1', status: 'expired', reason: 'insufficient_cash' },
      { orderId: 'b2', status: 'filled', price: 1000, quantity: 100, amount: 100_000 },
    ]);
    expect(r.account.cash).toBe(400_000);
  });

  it('受付順に処理する', () => {
    const r = settleSession(acc(300_000),
      [order('late', 'buy', 'AAAA', 100, null, 5), order('early', 'buy', 'BBBB', 100, null, 1)],
      prices({ AAAA: 2000, BBBB: 2000 }));
    expect(r.results[0]).toMatchObject({ orderId: 'early', status: 'filled' });
    expect(r.results[1]).toMatchObject({ orderId: 'late', status: 'expired' });
  });

  it('金額指定は買える最大株数（100株単位）', () => {
    const r = settleSession(acc(10_000_000), [order('b', 'buy', 'AAAA', null, 1_000_000, 1)], prices({ AAAA: 2891 }));
    expect(r.results[0]).toMatchObject({ status: 'filled', quantity: 300, amount: 867_300 });
  });

  it('金額指定で1単元も買えなければ失効', () => {
    const r = settleSession(acc(10_000_000), [order('b', 'buy', 'AAAA', null, 100_000, 1)], prices({ AAAA: 2891 }));
    expect(r.results[0]).toMatchObject({ status: 'expired', reason: 'amount_too_small' });
  });

  it('値が付かなければ失効', () => {
    const r = settleSession(acc(10_000_000), [order('b', 'buy', 'AAAA', 100, null, 1)], prices({ AAAA: null }));
    expect(r.results[0]).toMatchObject({ status: 'expired', reason: 'no_trade' });
  });

  it('保有不足の売りは失効', () => {
    const r = settleSession(acc(0, { AAAA: [100, 100_000] }), [order('s', 'sell', 'AAAA', 200, null, 1)], prices({ AAAA: 1000 }));
    expect(r.results[0]).toMatchObject({ status: 'expired', reason: 'insufficient_holdings' });
  });

  it('一部売却で取得総額を按分する', () => {
    const r = settleSession(acc(0, { AAAA: [300, 300_000] }), [order('s', 'sell', 'AAAA', 100, null, 1)], prices({ AAAA: 1500 }));
    expect(r.account.holdings.get('AAAA')).toEqual({ quantity: 200, cost: 200_000 });
    expect(r.account.cash).toBe(150_000);
  });

  it('小数の株価でも金額は整数', () => {
    const r = settleSession(acc(1_000_000), [order('b', 'buy', 'AAAA', 100, null, 1)], prices({ AAAA: 1234.5 }));
    expect(r.results[0]).toMatchObject({ amount: 123_450 });
  });

  it('元の口座を変更しない', () => {
    const a = acc(1_000_000);
    settleSession(a, [order('b', 'buy', 'AAAA', 100, null, 1)], prices({ AAAA: 1000 }));
    expect(a.cash).toBe(1_000_000);
    expect(a.holdings.size).toBe(0);
  });
});

describe('marketValue / rankByTotal', () => {
  it('終値がなければ取得額で評価', () => {
    const h = acc(0, { A: [100, 50_000], B: [200, 80_000] }).holdings;
    expect(marketValue(h, (t) => (t === 'A' ? 600 : undefined))).toBe(60_000 + 80_000);
  });
  it('同額は同順位', () => {
    expect(rankByTotal([{ total: 5 }, { total: 9 }, { total: 9 }]).map((r) => r.rank)).toEqual([1, 1, 3]);
  });
});
