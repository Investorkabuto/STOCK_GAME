// 約定エンジン（純粋関数）。DBに依存しないので、単体テストで挙動を固定できる。
//
// ルール（requirements.md 2.1）:
// - 同じセッションの注文は、売りを先、買いを後に処理する（それぞれ受付順）
// - 売りで得た資金はその場で買いに使える
// - 資金不足の買いは丸ごと失効（一部約定なし）。後続の注文は引き続き処理する
// - 保有不足の売りは失効
// - 値が付かなかった銘柄の注文は失効
// - 金額指定（買いのみ）は、約定価格で買える最大の株数（100株単位）を買う

export const LOT = 100;

export type Side = 'buy' | 'sell';

export interface Holding {
  quantity: number;
  /** 取得総額（円） */
  cost: number;
}

export interface AccountState {
  cash: number;
  holdings: Map<string, Holding>;
}

export interface EngineOrder {
  id: string;
  side: Side;
  ticker: string;
  quantity: number | null;
  amount: number | null;
  receivedMs: number;
}

export type PriceInfo = { status: 'ok'; price: number } | { status: 'no_trade' };

export type ExpireReason =
  | 'no_trade'
  | 'insufficient_cash'
  | 'insufficient_holdings'
  | 'amount_too_small';

export type OrderResult =
  | { orderId: string; status: 'filled'; price: number; quantity: number; amount: number }
  | { orderId: string; status: 'expired'; reason: ExpireReason };

export function cloneAccount(a: AccountState): AccountState {
  const holdings = new Map<string, Holding>();
  for (const [t, h] of a.holdings) holdings.set(t, { ...h });
  return { cash: a.cash, holdings };
}

/** 約定金額（円）。株価に小数があっても整数に丸める */
export function tradeAmount(price: number, quantity: number): number {
  return Math.round(price * quantity);
}

function byReceived(a: EngineOrder, b: EngineOrder): number {
  return a.receivedMs - b.receivedMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * 1口座・1セッション分の注文を約定させる。
 * priceOf が undefined を返す銘柄があってはならない（呼び出し側で全銘柄の価格がそろってから呼ぶ）。
 */
export function settleSession(
  account: AccountState,
  orders: readonly EngineOrder[],
  priceOf: (ticker: string) => PriceInfo,
): { account: AccountState; results: OrderResult[] } {
  const acc = cloneAccount(account);
  const results: OrderResult[] = [];
  const sells = orders.filter((o) => o.side === 'sell').sort(byReceived);
  const buys = orders.filter((o) => o.side === 'buy').sort(byReceived);

  for (const o of sells) {
    const p = priceOf(o.ticker);
    if (p.status !== 'ok') {
      results.push({ orderId: o.id, status: 'expired', reason: 'no_trade' });
      continue;
    }
    const qty = o.quantity ?? 0;
    const h = acc.holdings.get(o.ticker);
    if (!h || qty <= 0 || h.quantity < qty) {
      results.push({ orderId: o.id, status: 'expired', reason: 'insufficient_holdings' });
      continue;
    }
    const amount = tradeAmount(p.price, qty);
    const costOut = qty === h.quantity ? h.cost : Math.round((h.cost * qty) / h.quantity);
    h.quantity -= qty;
    h.cost -= costOut;
    if (h.quantity === 0) acc.holdings.delete(o.ticker);
    acc.cash += amount;
    results.push({ orderId: o.id, status: 'filled', price: p.price, quantity: qty, amount });
  }

  for (const o of buys) {
    const p = priceOf(o.ticker);
    if (p.status !== 'ok') {
      results.push({ orderId: o.id, status: 'expired', reason: 'no_trade' });
      continue;
    }
    let qty: number;
    if (o.amount !== null) {
      qty = Math.floor(o.amount / (p.price * LOT)) * LOT;
      // 丸め誤差で予算を超えないよう補正する
      while (qty > 0 && tradeAmount(p.price, qty) > o.amount) qty -= LOT;
      if (qty <= 0) {
        results.push({ orderId: o.id, status: 'expired', reason: 'amount_too_small' });
        continue;
      }
    } else {
      qty = o.quantity ?? 0;
    }
    const amount = tradeAmount(p.price, qty);
    if (qty <= 0 || amount > acc.cash) {
      results.push({ orderId: o.id, status: 'expired', reason: 'insufficient_cash' });
      continue;
    }
    acc.cash -= amount;
    const h = acc.holdings.get(o.ticker) ?? { quantity: 0, cost: 0 };
    h.quantity += qty;
    h.cost += amount;
    acc.holdings.set(o.ticker, h);
    results.push({ orderId: o.id, status: 'filled', price: p.price, quantity: qty, amount });
  }

  return { account: acc, results };
}

/** 評価額。終値が無い銘柄は lastPrice（直近の終値）、それも無ければ取得単価で評価する */
export function marketValue(
  holdings: ReadonlyMap<string, Holding>,
  lastPrice: (ticker: string) => number | undefined,
): number {
  let v = 0;
  for (const [ticker, h] of holdings) {
    const p = lastPrice(ticker);
    v += p === undefined ? h.cost : tradeAmount(p, h.quantity);
  }
  return v;
}

/** 総資産の降順で順位を付ける（同額は同順位） */
export function rankByTotal<T extends { total: number }>(rows: T[]): (T & { rank: number })[] {
  const sorted = [...rows].sort((a, b) => b.total - a.total);
  let prevTotal: number | null = null;
  let prevRank = 0;
  return sorted.map((r, i) => {
    const rank = r.total === prevTotal ? prevRank : i + 1;
    prevTotal = r.total;
    prevRank = rank;
    return { ...r, rank };
  });
}

/** 月間リターン（その月の開始時の総資産に対する増減率）の降順で順位を付ける（同率は同順位） */
export function rankByReturn<T extends { total: number; start_total: number }>(rows: T[]): (T & { rank: number })[] {
  const ret = (r: T) => r.total / r.start_total;
  const sorted = [...rows].sort((a, b) => ret(b) - ret(a));
  let prev: number | null = null;
  let prevRank = 0;
  return sorted.map((r, i) => {
    const v = ret(r);
    const rank = prev !== null && Math.abs(v - prev) < 1e-12 ? prevRank : i + 1;
    prev = v;
    prevRank = rank;
    return { ...r, rank };
  });
}

/** 増減率（%、小数第2位まで） */
export function returnPct(total: number, base: number): number {
  return Math.round(((total - base) / base) * 10000) / 100 || 0; // -0 を 0 にする
}
