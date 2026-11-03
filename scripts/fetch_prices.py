"""精算待ちの銘柄の始値・終値を Yahoo Finance から取得し、アプリに書き込む。

GitHub Actions から定期的に実行する（.github/workflows/prices.yml）。何度実行しても安全。
  1. GET  /internal/price-requests で、まだ価格がない (取引日, 寄付き/引け, 銘柄) を取得
  2. yfinance で日足を取得
  3. POST /internal/prices で書き込む（値が付かなかった銘柄は price=null）

環境変数: API_BASE_URL, INGEST_TOKEN
引数 --final: その日の最終実行。データが見つからない銘柄を「値が付かなかった」として確定させる
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import sys
import urllib.error
import urllib.request

import yfinance as yf

USER_AGENT = "stock-game-ingest/1.0 (+https://github.com/Investorkabuto/STOCK_GAME)"
JST = dt.timezone(dt.timedelta(hours=9))
# 終値は大引け（15:30）後しばらくしないと確定しないため、それより前は当日の終値を取りに行かない
CLOSE_READY = dt.time(15, 45)


def api(method: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(
        os.environ["API_BASE_URL"].rstrip("/") + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {os.environ['INGEST_TOKEN']}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        # 原因が分かるよう、応答本文の先頭をログに出す
        detail = e.read(500).decode("utf-8", "replace")
        raise SystemExit(f"API error {e.code} on {method} {path}: {detail}") from e


def daily_bars(tickers: list[str], trade_date: str) -> dict[str, dict]:
    """銘柄ごとの、その日の日足 {open, close, volume}。データが無い銘柄は含まない"""
    start = dt.date.fromisoformat(trade_date)
    end = start + dt.timedelta(days=1)
    symbols = [f"{t}.T" for t in tickers]
    df = yf.download(symbols, start=start.isoformat(), end=end.isoformat(), group_by="ticker",
                     auto_adjust=False, progress=False, threads=True)
    out: dict[str, dict] = {}
    for t, s in zip(tickers, symbols):
        try:
            # yfinance は group_by="ticker" のとき、銘柄が1つでも列が (銘柄, 項目) の2段になる版がある
            sub = df[s] if getattr(df.columns, "nlevels", 1) > 1 else df
            row = sub.loc[sub.index.strftime("%Y-%m-%d") == trade_date]
            if row.empty:
                continue
            r = row.iloc[0]
            out[t] = {"open": float(r["Open"]), "close": float(r["Close"]), "volume": float(r["Volume"])}
        except (KeyError, IndexError):
            continue
    return out


def sync_corporate_actions() -> None:
    """保有されている銘柄の、直近10日の配当・株式分割を登録する（権利落ち日の精算前に反映される）"""
    tickers = api("GET", "/internal/held-tickers")["tickers"]
    if not tickers:
        return
    symbols = [f"{t}.T" for t in tickers]
    df = yf.download(symbols, period="10d", interval="1d", actions=True, group_by="ticker",
                     auto_adjust=False, progress=False, threads=True)
    actions: list[dict] = []
    for t, s in zip(tickers, symbols):
        try:
            sub = df[s] if getattr(df.columns, "nlevels", 1) > 1 else df
        except KeyError:
            continue
        for idx, row in sub.iterrows():
            date = idx.strftime("%Y-%m-%d")
            div = float(row.get("Dividends", 0) or 0)
            split = float(row.get("Stock Splits", 0) or 0)
            if div > 0 and not math.isnan(div):
                actions.append({"ticker": t, "ex_date": date, "kind": "dividend", "amount": round(div, 4)})
            if split > 0 and not math.isnan(split) and split != 1:
                actions.append({"ticker": t, "ex_date": date, "kind": "split", "ratio": split})
    if actions:
        res = api("POST", "/internal/corporate-actions", {"actions": actions})
        print(f"corporate actions: {res['upserted']}")


def usable(v: float) -> bool:
    return v is not None and not math.isnan(v) and v > 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--final", action="store_true")
    parser.add_argument("--probe", metavar="TICKER", help="アプリに書き込まず、指定銘柄の直近5営業日の日足を表示する（Yahoo への接続確認用）")
    args = parser.parse_args()
    if args.probe:
        df = yf.download(f"{args.probe}.T", period="5d", interval="1d", auto_adjust=False, progress=False)
        print(df)
        return 0 if not df.empty else 1
    now = dt.datetime.now(JST)

    try:
        sync_corporate_actions()
    except Exception as e:  # 配当・分割の取得に失敗しても、株価の取り込みは止めない
        print(f"WARN corporate actions: {e}", file=sys.stderr)
    requests = api("GET", "/internal/price-requests")["requests"]
    if not requests:
        print("no pending price requests")
        return 0

    rows: list[dict] = []
    for req in requests:
        date, field, tickers = req["trade_date"], req["field"], req["tickers"]
        if field == "close" and date == now.date().isoformat() and now.time() < CLOSE_READY:
            print(f"skip {date} close: before {CLOSE_READY}")
            continue
        bars = daily_bars(tickers, date)
        if not bars and not args.final:
            # 1銘柄も取れない場合は取得の失敗とみなし、何も書き込まない（精算は保留される）
            print(f"WARN {date} {field}: no data for any ticker; will retry", file=sys.stderr)
            continue
        for t in tickers:
            bar = bars.get(t)
            if bar is None:
                if args.final:
                    rows.append({"ticker": t, "trade_date": date, "field": field, "price": None})
                continue
            # 出来高0は値が付かなかった（ストップ高・安の張り付きなど）
            value = bar[field]
            price = round(value, 1) if bar["volume"] > 0 and usable(value) else None
            rows.append({"ticker": t, "trade_date": date, "field": field, "price": price})

    if rows:
        res = api("POST", "/internal/prices", {"prices": rows})
        print(f"upserted {res['upserted']} prices")
    return 0


if __name__ == "__main__":
    sys.exit(main())
