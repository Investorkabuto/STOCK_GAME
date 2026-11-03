import { describe, expect, it } from 'vitest';
import { rankByReturn, returnPct } from '../src/lib/engine';
import { autoCommentary } from '../src/operator/scheduler';

describe('rankByReturn', () => {
  it('ranks by monthly return, not by total assets', () => {
    const rows = [
      { id: 'big', total: 12_000_000, start_total: 12_500_000 }, // -4%
      { id: 'small', total: 10_100_000, start_total: 10_000_000 }, // +1%
      { id: 'tie', total: 20_200_000, start_total: 20_000_000 }, // +1%
    ];
    const r = rankByReturn(rows);
    expect(r.map((x) => [x.id, x.rank])).toEqual([
      ['small', 1],
      ['tie', 1],
      ['big', 3],
    ]);
  });
  it('returnPct rounds to 2 decimals', () => {
    expect(returnPct(10_060_000, 10_000_000)).toBe(0.6);
    expect(returnPct(9_999_999, 10_000_000)).toBe(0);
  });
});

describe('autoCommentary', () => {
  it('builds short lines from fills, expiries and standings', () => {
    const lines = autoCommentary({
      trade_date: '2026-12-01',
      timing: 'close',
      fills: [{ agent_id: 'a', display_name: 'Alpha', side: 'buy', ticker: '7203', name: 'トヨタ自動車', quantity: 300, price: 3000 }],
      expired: [{ agent_id: 'b', display_name: 'Beta', side: 'buy', ticker: '6758', reason: 'insufficient_cash' }],
      standings: [{ rank: 1, previous_rank: 2, agent_id: 'a', display_name: 'Alpha', month_return_pct: 1.5, total_return_pct: 3, overlap_pct: null }],
    });
    expect(lines).toEqual([
      'Alpha が 7203 トヨタ自動車 を引けで300株買い',
      '引けの注文 1件 が不成立（資金不足）',
      '1位 Alpha 月間 +1.50%（2位から浮上）',
    ]);
    expect(lines.every((l) => l.length <= 80)).toBe(true);
  });
});

import { overlapPct } from '../src/lib/engine';

describe('overlapPct', () => {
  it('shares of holdings value also held by another AI', () => {
    const m = overlapPct([
      { agent_id: 'a', ticker: '7203', value: 300 },
      { agent_id: 'a', ticker: '9999', value: 100 },
      { agent_id: 'b', ticker: '7203', value: 50 },
      { agent_id: 'c', ticker: '1111', value: 10 },
      { agent_id: 'd', ticker: '2222', value: 0 },
    ]);
    expect(m.get('a')).toBe(75);
    expect(m.get('b')).toBe(100);
    expect(m.get('c')).toBe(0);
    expect(m.get('d')).toBe(null);
  });
});
