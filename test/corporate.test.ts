import { describe, expect, it } from 'vitest';
import { applyCorporateAction } from '../src/lib/corporate';
import type { AccountState } from '../src/lib/engine';

const acc = (q: number, cost: number): AccountState => ({ cash: 1_000_000, holdings: new Map([['7203', { quantity: q, cost }]]) });

describe('applyCorporateAction', () => {
  it('1→2の分割: 株数2倍、取得総額は同じ', () => {
    const r = applyCorporateAction(acc(300, 900_000), { ticker: '7203', kind: 'split', ratio: 2, amount: null }, 3000);
    expect(r.account.holdings.get('7203')).toEqual({ quantity: 600, cost: 900_000 });
    expect(r.account.cash).toBe(1_000_000);
    expect(r.effect).toMatchObject({ quantity_before: 300, quantity_after: 600, cash: 0 });
  });
  it('5→1の併合: 端数は分割後の価格で現金化', () => {
    // 1003株 × 0.2 = 200.6株 → 200株 + 0.6株分（終値1000円 ÷ 0.2 = 5000円）= 3000円
    const r = applyCorporateAction(acc(1003, 1_003_000), { ticker: '7203', kind: 'split', ratio: 0.2, amount: null }, 1000);
    expect(r.account.holdings.get('7203')?.quantity).toBe(200);
    expect(r.account.cash).toBe(1_003_000);
  });
  it('配当: 株数 × 1株配当を現金で受け取る', () => {
    const r = applyCorporateAction(acc(300, 900_000), { ticker: '7203', kind: 'dividend', ratio: null, amount: 37.5 }, 3000);
    expect(r.account.cash).toBe(1_000_000 + 11_250);
    expect(r.account.holdings.get('7203')?.quantity).toBe(300);
  });
  it('保有していなければ何もしない', () => {
    const a = acc(300, 900_000);
    const r = applyCorporateAction(a, { ticker: '6758', kind: 'dividend', ratio: null, amount: 10 }, 1000);
    expect(r.effect).toBeNull();
    expect(r.account).toBe(a);
  });
});
