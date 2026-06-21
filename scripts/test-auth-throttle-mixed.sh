#!/usr/bin/env bash
# Mixed-type concurrency test.
# Fires N parallel begin_auth_attempt calls for BOTH 'signin' and 'reset'
# against the same email and verifies the per-(email, type) advisory lock
# keeps the two counters independent: each type should get exactly MAX
# granted slots and the rest should be locked out.

set -euo pipefail

if [ -z "${PGHOST:-}" ]; then
  echo "PGHOST not set — this script needs managed Supabase psql access." >&2
  exit 2
fi

N=${N:-15}      # per type
MAX=${MAX:-5}
EMAIL="mixed-test-$(date +%s%N)@example.test"

echo "Test email: $EMAIL"
echo "Firing $N parallel signin + $N parallel reset calls (max=$MAX per type)..."

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

for t in signin reset; do
  for i in $(seq 1 "$N"); do
    (
      psql -At -c "SELECT public.begin_auth_attempt('$EMAIL','$t')::text" \
        > "$TMP/r-$t-$i.txt" 2>"$TMP/e-$t-$i.txt"
    ) &
  done
done
wait

FAIL=0
for t in signin reset; do
  GRANTED=0
  LOCKED=0
  ERRORS=0
  for i in $(seq 1 "$N"); do
    if [ ! -s "$TMP/r-$t-$i.txt" ]; then
      ERRORS=$((ERRORS + 1))
      cat "$TMP/e-$t-$i.txt" >&2
      continue
    fi
    RESULT=$(cat "$TMP/r-$t-$i.txt")
    case "$RESULT" in
      *'"locked": true'*|*'"locked":true'*) LOCKED=$((LOCKED + 1));;
      *'"locked": false'*|*'"locked":false'*) GRANTED=$((GRANTED + 1));;
      *) ERRORS=$((ERRORS + 1)); echo "Unexpected: $RESULT" >&2;;
    esac
  done
  ROWS=$(psql -At -c "SELECT count(*) FROM public.auth_throttle WHERE email_norm='$EMAIL' AND attempt_type='$t' AND success=false")
  echo "[$t] granted=$GRANTED locked=$LOCKED errors=$ERRORS rows=$ROWS"
  if [ "$GRANTED" -ne "$MAX" ] || [ "$LOCKED" -ne "$((N - MAX))" ] || [ "$ROWS" -ne "$MAX" ] || [ "$ERRORS" -ne 0 ]; then
    echo "FAIL: [$t] expected granted=$MAX locked=$((N - MAX)) rows=$MAX errors=0" >&2
    FAIL=1
  fi
done

# Sanity check: a 'finalize' with success=true on a signin reservation must
# only clear signin failures, NOT the reset counter for the same email.
SIGNIN_ID=$(psql -At -c "SELECT id FROM public.auth_throttle WHERE email_norm='$EMAIL' AND attempt_type='signin' AND success=false ORDER BY id LIMIT 1")
if [ -n "$SIGNIN_ID" ]; then
  psql -At -c "SELECT public.finalize_auth_attempt($SIGNIN_ID, true)" > /dev/null
  RESET_ROWS_AFTER=$(psql -At -c "SELECT count(*) FROM public.auth_throttle WHERE email_norm='$EMAIL' AND attempt_type='reset' AND success=false")
  SIGNIN_ROWS_AFTER=$(psql -At -c "SELECT count(*) FROM public.auth_throttle WHERE email_norm='$EMAIL' AND attempt_type='signin' AND success=false")
  echo "After successful signin finalize: signin_failures=$SIGNIN_ROWS_AFTER  reset_failures=$RESET_ROWS_AFTER"
  if [ "$RESET_ROWS_AFTER" -ne "$MAX" ]; then
    echo "FAIL: successful signin should not affect reset counter (expected $MAX, got $RESET_ROWS_AFTER)" >&2
    FAIL=1
  fi
  if [ "$SIGNIN_ROWS_AFTER" -ne 0 ]; then
    echo "FAIL: successful signin should clear all signin failures (expected 0, got $SIGNIN_ROWS_AFTER)" >&2
    FAIL=1
  fi
fi

if [ "$FAIL" -eq 0 ]; then
  echo "PASS: signin and reset counters are independent under parallel load."
else
  exit 1
fi
