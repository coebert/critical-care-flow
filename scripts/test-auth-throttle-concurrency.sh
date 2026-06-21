#!/usr/bin/env bash
# Concurrency test for the auth throttle.
# Fires N parallel begin_auth_attempt calls for a single test email and verifies
# that exactly MAX_ATTEMPTS calls were granted an attempt_id (locked=false) and
# the rest were told locked=true. Confirms the per-email advisory lock + count
# is race-free under parallel load.

set -euo pipefail

if [ -z "${PGHOST:-}" ]; then
  echo "PGHOST not set — this script needs managed Supabase psql access." >&2
  exit 2
fi

N=${N:-20}
MAX=${MAX:-5}
TYPE=${TYPE:-signin}   # 'signin' or 'reset'
EMAIL="concurrency-test-$(date +%s%N)@example.test"

if [ "$TYPE" != "signin" ] && [ "$TYPE" != "reset" ]; then
  echo "TYPE must be 'signin' or 'reset' (got '$TYPE')" >&2
  exit 2
fi

echo "Test email: $EMAIL  type: $TYPE"
echo "Firing $N parallel begin_auth_attempt calls (max=$MAX)..."

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Fire N parallel RPCs. Each writes its JSONB result to its own file.
for i in $(seq 1 "$N"); do
  (
    psql -At -c "SELECT public.begin_auth_attempt('$EMAIL','$TYPE')::text" \
      > "$TMP/r-$i.txt" 2>"$TMP/e-$i.txt"
  ) &
done
wait

GRANTED=0
LOCKED=0
ERRORS=0
for i in $(seq 1 "$N"); do
  if [ ! -s "$TMP/r-$i.txt" ]; then
    ERRORS=$((ERRORS + 1))
    cat "$TMP/e-$i.txt" >&2
    continue
  fi
  RESULT=$(cat "$TMP/r-$i.txt")
  case "$RESULT" in
    *'"locked": true'*|*'"locked":true'*) LOCKED=$((LOCKED + 1));;
    *'"locked": false'*|*'"locked":false'*) GRANTED=$((GRANTED + 1));;
    *) ERRORS=$((ERRORS + 1)); echo "Unexpected result: $RESULT" >&2;;
  esac
done

echo "Granted: $GRANTED  Locked: $LOCKED  Errors: $ERRORS"

# Cross-check the table: failure rows for this email should equal GRANTED.
ROW_COUNT=$(psql -At -c "SELECT count(*) FROM public.auth_throttle WHERE email_norm='$EMAIL' AND attempt_type='$TYPE' AND success=false")
echo "auth_throttle rows for test email: $ROW_COUNT"

# No explicit cleanup: rows for this unique test email auto-expire via the
# 24h cleanup inside finalize_auth_attempt, and each run uses a fresh email.

FAIL=0
if [ "$GRANTED" -ne "$MAX" ]; then
  echo "FAIL: expected exactly $MAX granted attempts, got $GRANTED" >&2
  FAIL=1
fi
if [ "$LOCKED" -ne "$((N - MAX))" ]; then
  echo "FAIL: expected $((N - MAX)) locked responses, got $LOCKED" >&2
  FAIL=1
fi
if [ "$ROW_COUNT" -ne "$MAX" ]; then
  echo "FAIL: expected $MAX failure rows in auth_throttle, got $ROW_COUNT" >&2
  FAIL=1
fi
if [ "$ERRORS" -ne 0 ]; then
  echo "FAIL: $ERRORS RPC calls errored" >&2
  FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then
  echo "PASS: concurrent begin_auth_attempt is race-free."
else
  exit 1
fi
