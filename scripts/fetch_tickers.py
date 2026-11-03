"""JPX の上場銘柄一覧から、対象銘柄（内国株式のみ。ETF・REIT・外国株は除外）を取得してアプリに登録する。

一覧ファイル（data_j.xls）のURLは変わることがあるので、JPXの掲載ページからリンクを探して取得する。
環境変数: API_BASE_URL, INGEST_TOKEN
"""
from __future__ import annotations

import io
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

import pandas as pd

JPX_PAGE_URL = "https://www.jpx.co.jp/markets/statistics-equities/misc/01.html"
USER_AGENT = "stock-game-ingest/1.0 (+https://github.com/Investorkabuto/STOCK_GAME)"


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def find_list_url() -> str:
    html = get(JPX_PAGE_URL).decode("utf-8", "replace")
    m = re.search(r'href="([^"]*data_j\.xls[x]?)"', html)
    if not m:
        raise SystemExit(f"data_j.xls のリンクが {JPX_PAGE_URL} に見つかりません")
    return urllib.parse.urljoin(JPX_PAGE_URL, m.group(1))


def main() -> int:
    list_url = find_list_url()
    print(f"list: {list_url}")
    df = pd.read_excel(io.BytesIO(get(list_url)), dtype=str)
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
        headers={
            "Authorization": f"Bearer {os.environ['INGEST_TOKEN']}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            print(json.load(r))
    except urllib.error.HTTPError as e:
        raise SystemExit(f"API error {e.code}: {e.read(500).decode('utf-8', 'replace')}") from e
    return 0


if __name__ == "__main__":
    sys.exit(main())
