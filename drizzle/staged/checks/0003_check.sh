#!/usr/bin/env bash
# Disposable Postgres check for drizzle/staged/0003_wardable_revision_fence.sql.
# Synthetic data only; never touches the project database.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../0003_wardable_revision_fence.sql"
MIG6="$HERE/../0006_wardable_reviewed_intent.sql"
WORK="$(mktemp -d /tmp/pg0003.XXXXXX)"
PORT="${PORT:-55433}"
PGBIN="$(dirname "$(command -v initdb)")"
cleanup() { "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
RUNAS=""
if [ "$(id -u)" = "0" ]; then
  # Postgres refuses to run as root: use a throwaway unprivileged uid.
  id pgcheck >/dev/null 2>&1 || useradd -M pgcheck 2>/dev/null || echo "pgcheck:x:55433:55433::/tmp:/bin/false" >> /etc/passwd
  chown -R pgcheck "$WORK"; RUNAS="setpriv --reuid=$(id -u pgcheck) --regid=$(id -u pgcheck) --clear-groups --"
fi
$RUNAS "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
$RUNAS "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -l "$WORK/log" -w start >/dev/null
export PGHOST="$WORK" PGPORT="$PORT" PGUSER=postgres
unset PGPASSWORD PGDATABASE PGSSLMODE || true
export PGOPTIONS="-c client_min_messages=warning"
PSQL=(psql -X -q -v ON_ERROR_STOP=1 -At)
pass=0; fail=0
ok()   { echo "PASS $1"; pass=$((pass+1)); }
bad()  { echo "FAIL $1 :: $2"; fail=$((fail+1)); }
eqv()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "got [$2] want [$3]"; fi; }
must_fail() { # name db sql expected_substring
  local out; if out=$("${PSQL[@]}" -d "$2" -c "$3" 2>&1); then bad "$1" "succeeded: $out"; else
    if [[ "$out" == *"$4"* ]]; then ok "$1"; else bad "$1" "$out"; fi; fi; }

U=11111111-1111-4111-8111-111111111111   # clinician
N=22222222-2222-4222-8222-222222222222   # non-clinical
P=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
Q=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
QU=BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB
AS_CLIN="SET request.jwt.claim.sub = '$U'; SET ROLE authenticated;"
AS_NON="SET request.jwt.claim.sub = '$N'; SET ROLE authenticated;"

# --- A. collision preflight refuses and applies nothing -------------------
createdb collide
"${PSQL[@]}" -d collide -f "$HERE/base_schema.sql"
"${PSQL[@]}" -d collide -c "INSERT INTO patient_wardable_status(partner_patient_id) VALUES ('$Q'), ('$QU')"
if out=$("${PSQL[@]}" -1 -d collide -f "$MIG" 2>&1); then bad "collision preflight" "applied"; else
  [[ "$out" == *"differ only by letter case"* ]] && ok "collision preflight refuses (no merge)" || bad "collision preflight" "$out"; fi
eqv "collision: nothing applied" "$("${PSQL[@]}" -d collide -c "SELECT to_regclass('public.patient_wardable_revision_counters') IS NULL AND (SELECT count(*) FROM patient_wardable_status) = 2")" "t"

# --- B. normal apply -------------------------------------------------------
createdb main
"${PSQL[@]}" -d main -f "$HERE/base_schema.sql"
"${PSQL[@]}" -d main -c "INSERT INTO user_roles VALUES ('$U','clinician'); INSERT INTO patient_wardable_status(partner_patient_id, desired_revision) VALUES ('$QU', 4)"
"${PSQL[@]}" -1 -d main -f "$MIG"
ok "migration applies in one transaction"
eqv "uppercase key normalised" "$("${PSQL[@]}" -d main -c "SELECT partner_patient_id FROM patient_wardable_status")" "$Q"
eqv "counter backfilled from overlay" "$("${PSQL[@]}" -d main -c "SELECT last_revision FROM patient_wardable_revision_counters WHERE partner_patient_id='$Q'")" "4"

# RPC with uppercase input → canonical key, next revision, TEXT revision in JSON.
eqv "RPC canonicalises id and returns text revision" \
  "$("${PSQL[@]}" -d main -c "$AS_CLIN SELECT partner_patient_id || '|' || (row_to_json(r)->>'desired_revision') || '|' || json_typeof(row_to_json(r)->'desired_revision') FROM set_wardable_desired_state('$QU', true) r")" \
  "$Q|5|string"
eqv "no duplicate case-variant rows" "$("${PSQL[@]}" -d main -c "SELECT count(*) FROM patient_wardable_status")" "1"

# Above 2^53: exact through RPC result, view JSON and CAS update.
"${PSQL[@]}" -d main -c "UPDATE patient_wardable_revision_counters SET last_revision = 9223372036854775805 WHERE partner_patient_id='$Q'"
eqv "RPC revision above 2^53 is exact text" \
  "$("${PSQL[@]}" -d main -c "$AS_CLIN SELECT row_to_json(r)->>'desired_revision' FROM set_wardable_desired_state('$Q', false) r")" "9223372036854775806"
eqv "view serialises revision as JSON string" \
  "$("${PSQL[@]}" -d main -c "$AS_CLIN SELECT json_typeof(row_to_json(v)->'desired_revision') || '|' || (row_to_json(v)->>'desired_revision') FROM patient_wardable_status_v v")" "string|9223372036854775806"
# PostgREST-style PATCH: JSON string payload + text filter, as service_role.
CAS="SET ROLE service_role; WITH p AS (SELECT * FROM jsonb_populate_record(NULL::patient_wardable_status, '{\"partner_sync_status\":\"synced\",\"partner_synced_revision\":\"REV\"}'))
  UPDATE patient_wardable_status w SET partner_sync_status = p.partner_sync_status, partner_synced_revision = p.partner_synced_revision
  FROM p WHERE w.partner_patient_id = '$Q' AND w.desired_revision = 'FILTER' RETURNING w.partner_patient_id"
out=$("${PSQL[@]}" -d main -c "$(echo "${CAS//REV/9223372036854775806}" | sed "s/'FILTER'/'9223372036854775805'/")" | grep -c . || true)
eqv "CAS with stale revision updates 0 rows" "$out" "0"
out=$("${PSQL[@]}" -d main -c "$(echo "${CAS//REV/9223372036854775806}" | sed "s/'FILTER'/'9223372036854775806'/")" | grep -c . || true)
eqv "CAS with exact revision updates 1 row" "$out" "1"
eqv "synced revision stored exactly" "$("${PSQL[@]}" -d main -c "SELECT partner_synced_revision FROM patient_wardable_status_v")" "9223372036854775806"

# 2^53+1: the value a JavaScript number would round to must NOT match.
R="cccccccc-0000-4000-8000-000000000001"
"${PSQL[@]}" -d main -c "INSERT INTO patient_wardable_revision_counters VALUES ('$R', 9007199254740992)"
eqv "2^53+1 allocated exactly" "$("${PSQL[@]}" -d main -c "$AS_CLIN SELECT desired_revision FROM set_wardable_desired_state('$R', true)")" "9007199254740993"
eqv "rounded JS value (2^53) does not match the CAS" \
  "$("${PSQL[@]}" -d main -c "SET ROLE service_role; UPDATE patient_wardable_status SET partner_sync_status='synced' WHERE partner_patient_id='$R' AND desired_revision = '9007199254740992' RETURNING 1" | grep -c . || true)" "0"
eqv "exact text value matches the CAS" \
  "$("${PSQL[@]}" -d main -c "SET ROLE service_role; UPDATE patient_wardable_status SET partner_sync_status='synced', partner_synced_revision='9007199254740993' WHERE partner_patient_id='$R' AND desired_revision = '9007199254740993' RETURNING 1" | grep -c . || true)" "1"

# Overflow fails closed and rolls back.
"${PSQL[@]}" -d main -c "UPDATE patient_wardable_revision_counters SET last_revision = 9223372036854775807 WHERE partner_patient_id='$Q'"
must_fail "allocator overflow fails" main "$AS_CLIN SELECT * FROM set_wardable_desired_state('$Q', true)" "out of range"
eqv "overflow left overlay unchanged" "$("${PSQL[@]}" -d main -c "SELECT desired_revision || '|' || wardable FROM patient_wardable_status WHERE partner_patient_id='$Q'")" "9223372036854775806|false"

# --- C. counter durability and permissions ---------------------------------
must_fail "service_role cannot delete counters (grant)" main "SET ROLE service_role; DELETE FROM patient_wardable_revision_counters" "permission denied"
must_fail "service_role cannot update counters (grant)" main "SET ROLE service_role; UPDATE patient_wardable_revision_counters SET last_revision = 0" "permission denied"
must_fail "authenticated cannot read counters" main "$AS_CLIN SELECT * FROM patient_wardable_revision_counters" "permission denied"
must_fail "even the owner cannot delete counters" main "DELETE FROM patient_wardable_revision_counters" "permanent"
must_fail "even the owner cannot truncate counters" main "TRUNCATE patient_wardable_revision_counters" "permanent"
must_fail "counter cannot decrease" main "UPDATE patient_wardable_revision_counters SET last_revision = 1" "cannot decrease"
must_fail "counter key cannot change" main "UPDATE patient_wardable_revision_counters SET partner_patient_id = '$P'" "cannot change"

# Overlay deletion/recreation never resets the revision.
"${PSQL[@]}" -d main -c "INSERT INTO patient_wardable_revision_counters VALUES ('$P', 0)"
"${PSQL[@]}" -d main -c "$AS_CLIN SELECT * FROM set_wardable_desired_state('$P', true)" >/dev/null
"${PSQL[@]}" -d main -c "$AS_CLIN SELECT * FROM set_wardable_desired_state('$P', false)" >/dev/null
"${PSQL[@]}" -d main -c "SET ROLE service_role; DELETE FROM patient_wardable_status WHERE partner_patient_id = '$P'"
eqv "recreated overlay continues the revision" "$("${PSQL[@]}" -d main -c "$AS_CLIN SELECT desired_revision FROM set_wardable_desired_state('$P', true)")" "3"

# Rollback consumes nothing.
"${PSQL[@]}" -d main -c "BEGIN; $AS_CLIN SELECT * FROM set_wardable_desired_state('$P', false); ROLLBACK;" >/dev/null
eqv "rolled-back toggle does not advance the counter" "$("${PSQL[@]}" -d main -c "SELECT last_revision FROM patient_wardable_revision_counters WHERE partner_patient_id='$P'")" "3"

# --- D. direct DML cannot fake state or actor -------------------------------
must_fail "authenticated cannot set desired_revision directly" main "$AS_CLIN UPDATE patient_wardable_status SET desired_revision = desired_revision + 10 WHERE partner_patient_id='$P'" "set_wardable_desired_state"
must_fail "authenticated cannot set wardable directly" main "$AS_CLIN UPDATE patient_wardable_status SET wardable = false WHERE partner_patient_id='$P'" "set_wardable_desired_state"
must_fail "authenticated cannot record sync outcomes" main "$AS_CLIN UPDATE patient_wardable_status SET partner_sync_status = 'synced' WHERE partner_patient_id='$P'" "server only"
must_fail "authenticated cannot insert wardable=true" main "$AS_CLIN INSERT INTO patient_wardable_status(partner_patient_id, wardable) VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', true)" "set_wardable_desired_state"
must_fail "non-canonical key rejected on direct insert" main "$AS_CLIN INSERT INTO patient_wardable_status(partner_patient_id) VALUES ('CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC')" "canonical_id"
"${PSQL[@]}" -d main -c "$AS_CLIN UPDATE patient_wardable_status SET discharged_at = now(), updated_by = '$N' WHERE partner_patient_id='$P'"
eqv "actor is forced to auth.uid()" "$("${PSQL[@]}" -d main -c "SELECT updated_by FROM patient_wardable_status WHERE partner_patient_id='$P'")" "$U"
must_fail "service_role cannot rewrite desired_revision" main "SET ROLE service_role; UPDATE patient_wardable_status SET desired_revision = 1 WHERE partner_patient_id='$P'" "set_wardable_desired_state"
must_fail "non-clinician RPC forbidden" main "$AS_NON SELECT * FROM set_wardable_desired_state('$P', true)" "forbidden"
must_fail "anon cannot execute RPC" main "SET ROLE anon; SELECT * FROM set_wardable_desired_state('$P', true)" "permission denied"
eqv "non-clinician sees no rows through the view" "$("${PSQL[@]}" -d main -c "$AS_NON SELECT count(*) FROM patient_wardable_status_v")" "0"

# --- E. concurrency: overlapping toggles serialise on the counter lock -------
before=$("${PSQL[@]}" -d main -c "SELECT last_revision FROM patient_wardable_revision_counters WHERE partner_patient_id='$P'")
( "${PSQL[@]}" -d main -c "BEGIN; $AS_CLIN SELECT desired_revision FROM set_wardable_desired_state('$P', true); SELECT pg_sleep(1.5); COMMIT;" > "$WORK/a.out" ) &
sleep 0.4
start=$(date +%s.%N)
"${PSQL[@]}" -d main -c "$AS_CLIN SELECT desired_revision FROM set_wardable_desired_state('$P', false)" > "$WORK/b.out"
waited=$(echo "$(date +%s.%N) - $start > 0.8" | bc)
wait
a=$(grep -E '^[0-9]+$' "$WORK/a.out"); b=$(grep -E '^[0-9]+$' "$WORK/b.out")
eqv "second toggle waited for the first (row lock)" "$waited" "1"
eqv "concurrent toggles get consecutive revisions" "$a,$b" "$((before+1)),$((before+2))"
eqv "latest toggle wins locally" "$("${PSQL[@]}" -d main -c "SELECT desired_revision || '|' || wardable FROM patient_wardable_status WHERE partner_patient_id='$P'")" "$((before+2))|false"

# --- F. 0006 reviewed re-confirmation -----------------------------------------
"${PSQL[@]}" -1 -d main -f "$MIG6"
ok "0006 applies in one transaction"
S="dddddddd-dddd-4ddd-8ddd-dddddddddddd"
"${PSQL[@]}" -d main -c "INSERT INTO patient_wardable_revision_counters VALUES ('$S', 9007199254740992)"
"${PSQL[@]}" -d main -c "$AS_CLIN SELECT * FROM set_wardable_desired_state('$S', true)" >/dev/null   # rev 2^53+1
eqv "stale reviewed revision writes nothing" \
  "$("${PSQL[@]}" -d main -c "$AS_CLIN SELECT count(*) FROM confirm_wardable_reviewed_intent('$S', '9007199254740992', true)")" "0"
eqv "reviewed value mismatch writes nothing" \
  "$("${PSQL[@]}" -d main -c "$AS_CLIN SELECT count(*) FROM confirm_wardable_reviewed_intent('$S', '9007199254740993', false)")" "0"
eqv "stale confirm left revision and counter unchanged" \
  "$("${PSQL[@]}" -d main -c "SELECT w.desired_revision || '|' || c.last_revision FROM patient_wardable_status w JOIN patient_wardable_revision_counters c USING (partner_patient_id) WHERE partner_patient_id='$S'")" \
  "9007199254740993|9007199254740993"
"${PSQL[@]}" -d main -c "SET ROLE service_role; UPDATE patient_wardable_status SET partner_sync_status='conflict', partner_synced_revision='9007199254740993' WHERE partner_patient_id='$S'"
eqv "exact reviewed revision (above 2^53) allocates the next one as text" \
  "$("${PSQL[@]}" -d main -c "$AS_CLIN SELECT (row_to_json(r)->>'desired_revision') || '|' || json_typeof(row_to_json(r)->'desired_revision') || '|' || r.wardable || '|' || r.partner_sync_status FROM confirm_wardable_reviewed_intent(upper('$S'), '9007199254740993', true) r")" \
  "9007199254740994|string|true|pending"
eqv "counter advanced with the overlay" "$("${PSQL[@]}" -d main -c "SELECT last_revision FROM patient_wardable_revision_counters WHERE partner_patient_id='$S'")" "9007199254740994"
eqv "replayed confirm of the old review writes nothing" \
  "$("${PSQL[@]}" -d main -c "$AS_CLIN SELECT count(*) FROM confirm_wardable_reviewed_intent('$S', '9007199254740993', true)")" "0"
must_fail "reviewed revision above bigint max fails" main "$AS_CLIN SELECT * FROM confirm_wardable_reviewed_intent('$S', '9223372036854775808', true)" "out of range"
must_fail "non-decimal reviewed revision rejected" main "$AS_CLIN SELECT * FROM confirm_wardable_reviewed_intent('$S', '1e3', true)" "invalid reviewed revision"
must_fail "non-clinician cannot confirm" main "$AS_NON SELECT * FROM confirm_wardable_reviewed_intent('$S', '9007199254740994', true)" "forbidden"
must_fail "anon cannot confirm" main "SET ROLE anon; SELECT * FROM confirm_wardable_reviewed_intent('$S', '9007199254740994', true)" "permission denied"
eqv "confirm records the signed-in actor" "$("${PSQL[@]}" -d main -c "SELECT updated_by FROM patient_wardable_status WHERE partner_patient_id='$S'")" "$U"
# Two confirmations of the SAME review race: exactly one allocates.
( "${PSQL[@]}" -d main -c "BEGIN; $AS_CLIN SELECT count(*) FROM confirm_wardable_reviewed_intent('$S', '9007199254740994', true); SELECT pg_sleep(1.2); COMMIT;" > "$WORK/c.out" ) &
sleep 0.4
"${PSQL[@]}" -d main -c "$AS_CLIN SELECT count(*) FROM confirm_wardable_reviewed_intent('$S', '9007199254740994', true)" > "$WORK/d.out"
wait
eqv "racing confirms of one review: one wins, one writes nothing" "$(grep -E '^[0-9]+$' "$WORK/c.out"),$(grep -E '^[0-9]+$' "$WORK/d.out")" "1,0"
eqv "only one new revision allocated" "$("${PSQL[@]}" -d main -c "SELECT desired_revision FROM patient_wardable_status WHERE partner_patient_id='$S'")" "9007199254740995"
# A toggle racing a confirm of the pre-toggle review: confirm writes nothing.
"${PSQL[@]}" -d main -c "$AS_CLIN SELECT * FROM set_wardable_desired_state('$S', false)" >/dev/null
eqv "confirm after a newer toggle writes nothing" \
  "$("${PSQL[@]}" -d main -c "$AS_CLIN SELECT count(*) FROM confirm_wardable_reviewed_intent('$S', '9007199254740995', true)")" "0"

echo "RESULT pass=$pass fail=$fail"
[ "$fail" = "0" ]
