"""JPX の上場銘柄一覧から、対象銘柄（内国株式のみ。ETF・REIT・外国株は除外）を取得してアプリに登録する。

環境変数: API_BASE_URL, INGEST_TOKEN
"""
from __future__ import annotations

import io
import json
import os
import sys
import urllib.request

import pandas as pd

JPX_LIST_URL = "https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls"


def main() -> int:
    with urllib.request.urlopen(JPX_LIST_URL, timeout=60) as r:
        df = pd.read_excel(io.BytesIO(r.read()), dtype=str)
    market_col = "市場・商品区分"
    domestic = df[df[market_col].str.contains("内国株式", na=False)]
    tickers = [
        {"code": str(row["コード"]).strip(), "name": str(row["銘柄名"]).strip(), "market": str(row[market_col]).strip()}
        for _, row in domestic.iterrows()
    ]
    if len(tickers) < 1000:
        print(f"ERROR: unexpectedly few tickers ({len(tickers)}); aborting", file=sys.stderr)
        return 1
    req = urllib.request.Request(
        os.environ["API_BASE_URL"].rstrip("/") + "/internal/tickers",
        method="PUT",
        data=json.dumps({"tickers": tickers}).encode(),
        headers={"Authorization": f"Bearer {os.environ['INGEST_TOKEN']}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        print(json.load(r))
    return 0


if __name__ == "__main__":
    sys.exit(main())
