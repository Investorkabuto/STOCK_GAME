#!/usr/bin/env bash
# 本番の動作確認（GitHub Actions の「Smoke test」から手動で実行する）。書き込みは行わない
set -u
BASE="${API_BASE_URL%/}"
UA="stock-game-smoke/1.0"
fail=0
check() { # 名前 期待ステータス パス
  code=$(curl -s -o /dev/null -w '%{http_code}' -A "$UA" "$BASE$3")
  if [ "$code" = "$2" ]; then echo "PASS $1 ($code)"; else echo "FAIL $1: expected $2, got $code"; fail=1; fi
}
check "top page" 200 /
check "llms.txt" 200 /llms.txt
check "rules" 200 /agents/rules.md
check "openapi" 200 /openapi.json
check "rules version" 200 /rules/version
check "leaderboard" 200 /leaderboard
check "stats page removed" 404 /stats
check "hall of fame" 200 /hall-of-fame
check "unknown AI page" 404 /ai/agt_nope
check "operator API without token" 401 /operator/tasks
check "admin API without token" 401 /admin/agents

echo "--- security headers (/)"
headers=$(curl -s -D - -o /dev/null -A "$UA" "$BASE/")
for h in content-security-policy x-content-type-options x-frame-options strict-transport-security; do
  if echo "$headers" | grep -qi "^$h:"; then echo "PASS header $h"; else echo "FAIL header $h missing"; fail=1; fi
done

echo "--- rules version"
curl -s -A "$UA" "$BASE/rules/version"; echo

echo "--- rate limit binding"
if curl -s -D - -o /dev/null -A "$UA" "$BASE/sandbox/challenge" | grep -qi "^x-ratelimit-limit:"; then echo "PASS rate limiter binding present"; else echo "FAIL rate limiter binding missing (X-RateLimit-Limit header absent)"; fail=1; fi

echo "--- rate limit: 100 unauthenticated GET /sandbox/challenge"
codes=""
for i in $(seq 1 100); do codes="$codes $(curl -s -o /dev/null -w '%{http_code}' -A "$UA" "$BASE/sandbox/challenge")"; done
n200=$(echo $codes | tr ' ' '\n' | grep -c '^200$'); n429=$(echo $codes | tr ' ' '\n' | grep -c '^429$')
first429=$(echo $codes | tr ' ' '\n' | grep -n '^429$' | head -1 | cut -d: -f1)
echo "200: $n200, 429: $n429, first 429 at request #${first429:-none}"
if [ "$n429" -gt 0 ]; then echo "PASS rate limit triggered"; else echo "WARN rate limit not triggered (Cloudflare counts per location and approximately)"; fi
exit $fail
