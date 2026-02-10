#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:21345}"
FUND_CODE="${2:-010421}"
ACCOUNT_ID="${3:-1}"
USERNAME="${4:-${FUNDVAL_USER:-}}"
PASSWORD="${5:-${FUNDVAL_PASS:-}}"
COOKIE_JAR="/tmp/fundval_smoke_cookie.txt"

rm -f "$COOKIE_JAR"

echo "[smoke] base=${BASE_URL} fund=${FUND_CODE} account=${ACCOUNT_ID}"

check() {
  local name="$1"
  local url="$2"
  local expect_auth="${3:-false}"
  local code

  if [[ "$expect_auth" == "true" ]]; then
    code=$(curl -sS -m 8 -b "$COOKIE_JAR" -c "$COOKIE_JAR" -o /tmp/fundval_smoke_body.txt -w "%{http_code}" "$url" || true)
  else
    code=$(curl -sS -m 8 -o /tmp/fundval_smoke_body.txt -w "%{http_code}" "$url" || true)
  fi

  if [[ "$code" =~ ^2 ]]; then
    echo "[ok] $name -> $code"
  else
    echo "[fail] $name -> $code"
    echo "----- body -----"
    cat /tmp/fundval_smoke_body.txt || true
    echo
    return 1
  fi
}

login_if_needed() {
  if [[ -z "$USERNAME" || -z "$PASSWORD" ]]; then
    echo "[info] no credentials provided, skip authenticated check"
    return 0
  fi

  local payload
  payload=$(printf '{"username":"%s","password":"%s"}' "$USERNAME" "$PASSWORD")

  local code
  code=$(curl -sS -m 8 -X POST \
    -H "Content-Type: application/json" \
    -d "$payload" \
    -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
    -o /tmp/fundval_smoke_login.txt \
    -w "%{http_code}" \
    "${BASE_URL}/api/auth/login" || true)

  if [[ "$code" =~ ^2 ]]; then
    echo "[ok] login -> $code ($USERNAME)"
  else
    echo "[fail] login -> $code"
    echo "----- body -----"
    cat /tmp/fundval_smoke_login.txt || true
    echo
    return 1
  fi
}

check "health" "${BASE_URL}/api/health"
check "project_info" "${BASE_URL}/api/info"
check "fund_detail" "${BASE_URL}/api/fund/${FUND_CODE}"
check "fund_history" "${BASE_URL}/api/fund/${FUND_CODE}/history?limit=10"

if login_if_needed; then
  if [[ -n "$USERNAME" && -n "$PASSWORD" ]]; then
    check "account_positions(auth)" "${BASE_URL}/api/account/positions?account_id=${ACCOUNT_ID}" true
  fi
fi

echo "[smoke] done"