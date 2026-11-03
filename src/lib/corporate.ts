// 配当・株式分割の反映（純粋関数）。
// - 分割: 1株を ratio 株にする（例: 1→2 なら ratio=2、5株→1株の併合なら ratio=0.2）。
//   端数は切り捨て、端数分は直近の終値を分割後に換算した価格で現金化する。取得総額は変えない
// - 配当: 権利落ち日の前日の引け後に保有していた株数 × 1株あたり配当 を現金で受け取る（実際の支払日は待たない）
import { tradeAmount, type AccountState } from './engine';

export interface CorporateAction {
  ticker: string;
  kind: 'split' | 'dividend';
  /** 分割: 1株あたりの新しい株数 */
  ratio: number | null;
  /** 配当: 1株あたりの金額（円） */
  amount: number | null;
}

export interface ActionEffect {
  ticker: string;
  kind: 'split' | 'dividend';
  quantity_before: number;
  quantity_after: number;
  cash: number;
}

export function applyCorporateAction(
  account: AccountState,
  action: CorporateAction,
  lastClose: number | undefined,
): { account: AccountState; effect: ActionEffect | null } {
  const h = account.holdings.get(action.ticker);
  if (!h || h.quantity <= 0) return { account, effect: null };
  const holdings = new Map(account.holdings);
  if (action.kind === 'dividend') {
    const cash = Math.round(h.quantity * (action.amount ?? 0));
    return { account: { cash: account.cash + cash, holdings }, effect: { ticker: action.ticker, kind: 'dividend', quantity_before: h.quantity, quantity_after: h.quantity, cash } };
  }
  const ratio = action.ratio ?? 1;
  const exact = h.quantity * ratio;
  const whole = Math.floor(exact + 1e-9);
  const fraction = exact - whole;
  // 端数の現金化: 分割前の終値 ÷ ratio が分割後の1株の価格
  const cashInLieu = fraction > 1e-9 && lastClose !== undefined ? tradeAmount(lastClose / ratio, fraction) : 0;
  if (whole > 0) holdings.set(action.ticker, { quantity: whole, cost: h.cost });
  else holdings.delete(action.ticker);
  return {
    account: { cash: account.cash + cashInLieu, holdings },
    effect: { ticker: action.ticker, kind: 'split', quantity_before: h.quantity, quantity_after: whole, cash: cashInLieu },
  };
}
