import { describe, expect, it } from 'vitest';
import { chartPoints, homeFormat, raceScale, renderHomeMarkdown } from '../src/web/home';
import { valuate, type StandingsResult } from '../src/routes/public';

describe('トップページ', () => {
  it('Accept でページの形式を選ぶ（ブラウザは HTML、AIのツールは Markdown）', () => {
    expect(homeFormat('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')).toBe('html');
    expect(homeFormat(undefined)).toBe('html');
    expect(homeFormat('*/*')).toBe('markdown');
    expect(homeFormat('text/markdown, text/plain;q=0.9')).toBe('markdown');
    expect(homeFormat('application/json')).toBe('json');
    expect(homeFormat('application/json, text/plain')).toBe('markdown');
  });

  it('棒の目盛りは、最大の値が収まるきりのいい幅', () => {
    expect(raceScale([])).toBe(5);
    expect(raceScale([4.2, -1.9])).toBe(5);
    expect(raceScale([-7.5])).toBe(10);
    expect(raceScale([150])).toBe(200);
  });

  it('資産推移の点: 月初の値も範囲に入れ、左右の端に点を置く', () => {
    const { pts, y } = chartPoints([10_000_000, 10_200_000, 9_900_000], 10_000_000, 340, 140, { l: 6, r: 6, t: 16, b: 20 });
    expect(pts[0]!.x).toBe(6);
    expect(pts[2]!.x).toBe(334);
    // 高い値ほど上（y が小さい）
    expect(pts[1]!.y).toBeLessThan(pts[0]!.y);
    expect(pts[2]!.y).toBeGreaterThan(pts[0]!.y);
    expect(y(10_200_000)).toBeGreaterThan(16);
    // 値が変わらなくても描ける
    const flat = chartPoints([10_000_000, 10_000_000], 10_000_000, 340, 140, { l: 6, r: 6, t: 16, b: 20 });
    expect(Number.isFinite(flat.pts[0]!.y)).toBe(true);
  });

  it('暫定評価: 価格がない銘柄は取得原価で評価する', () => {
    const v = valuate(1_000_000, [{ ticker: '7203', quantity: 100, cost: 250_000 }, { ticker: '6758', quantity: 10, cost: 30_000 }], (t) => (t === '7203' ? 3000.5 : undefined));
    expect(v).toEqual({ cash: 1_000_000, market_value: 300_050 + 30_000, total: 1_330_050 });
  });

  it('Markdown 版: 案内を先頭に置き、表のセルを壊さない', () => {
    const table: StandingsResult = {
      season_id: 'ssn_2026_11',
      is_test: true,
      as_of: '2026-11-04',
      live: null,
      rows: [
        {
          agent_id: 'a1', display_name: 'A|I', owner_name: null, state: 'entered', rank: 1, tactic: null, as_of: '2026-11-04',
          total: 10_100_000, cash: 100_000, market_value: 10_000_000, daily_change: 100_000, daily_change_pct: 1, month_return_pct: 1, total_return_pct: 1,
          continuing: false, overlap_pct: null, entry: { state: 'none', first_trade_date: null, tickers: [] }, holdings: [], recent: { trade_date: null, trades: [] },
          month_start_total: 10_000_000, history: [{ trade_date: '2026-11-04', total: 10_100_000 }], live: null,
        },
      ],
    };
    const md = renderHomeMarkdown(table, { timing: 'open', trade_date: '2026-11-05', ms: Date.parse('2026-11-04T23:45:00Z') });
    expect(md.split('\n').slice(0, 6).join('\n')).toContain('/llms.txt');
    expect(md).toContain('| 1 | A I |');
    expect(md).toContain('10,100,000');
  });
});
