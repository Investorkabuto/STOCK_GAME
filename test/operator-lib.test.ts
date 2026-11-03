import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/lib/markdown';
import { computeSignals, type SignalOrder } from '../src/lib/signals';

describe('renderMarkdown', () => {
  it('HTMLやスクリプトは文字として出す', () => {
    const html = renderMarkdown('<script>alert(1)</script> **太字**');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<strong>太字</strong>');
  });
  it('http(s)以外のリンクは作らない', () => {
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('<a ');
    expect(renderMarkdown('[x](https://example.com)')).toContain('<a href="https://example.com"');
  });
  it('見出し・リスト・表', () => {
    const html = renderMarkdown('# 日報\n\n- a\n- b\n\n1. x\n2. y\n\n| 順位 | AI |\n| --- | --- |\n| 1 | A |\n\n本文');
    expect(html).toContain('<h3>日報</h3>');
    expect(html).toContain('<ul><li>a</li><li>b</li></ul>');
    expect(html).toContain('<ol><li>x</li><li>y</li></ol>');
    expect(html).toContain('<td>A</td>');
    expect(html).toContain('<p>本文</p>');
  });
});

const o = (id: string, agent: string, extra: Partial<SignalOrder> = {}): SignalOrder => ({
  id, agent_id: agent, ticker: '7203', side: 'buy', timing: 'open', quantity: 100, amount: null,
  rationale: `${id} 独自の根拠です`, received_ms: 0, ip_prefix_hash: null, ...extra,
});

describe('computeSignals', () => {
  it('同一注文と根拠の使い回しを検出', () => {
    const s = computeSignals(
      [
        o('o1', 'A', { rationale: '円安で輸出株が買われやすいので順張りで買う', received_ms: 0 }),
        o('o2', 'B', { rationale: '円安で輸出株が買われやすいので順張りで買う', received_ms: 30_000 }),
        o('o3', 'C', { ticker: '6758', rationale: 'まったく別の理由で、半導体の受注増を評価した' }),
      ],
      new Map(),
    );
    const ident = s.find((x) => x.kind === 'identical_orders');
    expect(ident).toMatchObject({ agents: ['A', 'B'], order_ids: ['o1', 'o2'] });
    expect((ident as { score: number }).score).toBeGreaterThan(0.99);
    expect(s.find((x) => x.kind === 'rationale_similarity')).toMatchObject({ order_ids: ['o1', 'o2'], score: 1 });
    expect(s.some((x) => x.kind === 'rationale_similarity' && x.order_ids.includes('o3'))).toBe(false);
  });
  it('接続元のグループ', () => {
    const s = computeSignals(
      [o('o1', 'A', { ip_prefix_hash: 'h1', ticker: '1' }), o('o2', 'B', { ip_prefix_hash: 'h1', ticker: '2' }), o('o3', 'C', { ip_prefix_hash: 'h2', ticker: '3' })],
      new Map([['A', 'cls1'], ['B', 'cls1'], ['C', 'cls2']]),
    );
    expect(s).toContainEqual({ kind: 'same_operator_suspected', agents: ['A', 'B'], score: 0.9 });
    expect(s).toContainEqual({ kind: 'same_ip_range', agents: ['A', 'B'] });
  });
});
