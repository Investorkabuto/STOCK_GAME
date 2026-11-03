// 不正の兆候スコア（純粋関数）。運営AIはこのスコアと原データをあわせて判定する。
// スコアは判定材料のひとつにすぎず、これだけで裁定は決めない（operator-policy.md 4.1）。

export interface SignalOrder {
  id: string;
  agent_id: string;
  ticker: string;
  side: string;
  timing: string;
  quantity: number | null;
  amount: number | null;
  rationale: string;
  received_ms: number;
  ip_prefix_hash: string | null;
}

export type Signal =
  | { kind: 'same_operator_suspected'; agents: string[]; score: number }
  | { kind: 'same_ip_range'; agents: string[] }
  | { kind: 'identical_orders'; agents: string[]; order_ids: string[]; score: number }
  | { kind: 'rationale_similarity'; order_ids: string[]; agents: string[]; score: number };

const normalize = (s: string) => s.replace(/\s+/g, '').toLowerCase();

function trigrams(s: string): Set<string> {
  const t = normalize(s);
  const out = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  if (out.size === 0 && t.length > 0) out.add(t);
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * @param clusters agent_id → cluster_ref（登録時の接続元から推定した運営者グループ）
 * @param similarityThreshold 根拠文の類似とみなす下限（文字3-gramのJaccard係数）
 */
export function computeSignals(orders: SignalOrder[], clusters: Map<string, string | null>, similarityThreshold = 0.8): Signal[] {
  const signals: Signal[] = [];
  const agents = [...new Set(orders.map((o) => o.agent_id))];

  // 1. 登録時の接続元が同じグループ
  const byCluster = new Map<string, string[]>();
  for (const a of agents) {
    const c = clusters.get(a);
    if (c) byCluster.set(c, [...(byCluster.get(c) ?? []), a]);
  }
  for (const group of byCluster.values()) {
    if (group.length > 1) signals.push({ kind: 'same_operator_suspected', agents: group.sort(), score: 0.9 });
  }

  // 2. その日の注文の接続元が同じ範囲
  const byIp = new Map<string, Set<string>>();
  for (const o of orders) {
    if (!o.ip_prefix_hash) continue;
    byIp.set(o.ip_prefix_hash, (byIp.get(o.ip_prefix_hash) ?? new Set()).add(o.agent_id));
  }
  for (const set of byIp.values()) {
    if (set.size > 1) signals.push({ kind: 'same_ip_range', agents: [...set].sort() });
  }

  // 3. 別のAIによる同一内容の注文（受付時刻が近いほど高い）
  const byContent = new Map<string, SignalOrder[]>();
  for (const o of orders) {
    const key = [o.ticker, o.side, o.timing, o.quantity ?? '', o.amount ?? ''].join('|');
    byContent.set(key, [...(byContent.get(key) ?? []), o]);
  }
  for (const group of byContent.values()) {
    const distinct = new Set(group.map((o) => o.agent_id));
    if (distinct.size < 2) continue;
    const times = group.map((o) => o.received_ms);
    const spreadSec = (Math.max(...times) - Math.min(...times)) / 1000;
    signals.push({
      kind: 'identical_orders',
      agents: [...distinct].sort(),
      order_ids: group.map((o) => o.id),
      score: round2(1 - Math.min(spreadSec, 3600) / 3600 / 2),
    });
  }

  // 4. 根拠文の類似（別のAI同士、または同じAIの別注文）
  const grams = orders.map((o) => trigrams(o.rationale));
  const limit = Math.min(orders.length, 2000);
  for (let i = 0; i < limit; i++) {
    for (let j = i + 1; j < limit; j++) {
      const s = jaccard(grams[i]!, grams[j]!);
      if (s >= similarityThreshold) {
        const a = orders[i]!, b = orders[j]!;
        signals.push({ kind: 'rationale_similarity', order_ids: [a.id, b.id], agents: [...new Set([a.agent_id, b.agent_id])].sort(), score: round2(s) });
      }
    }
  }
  return signals;
}
