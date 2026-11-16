#!/usr/bin/env bash
# Disposable Postgres check for drizzle/staged/0007_referral_delete_lockdown.sql.
# Builds copies of the live referral grants/policies/triggers (base_referrals.sql),
# runs the same DELETE matrix BEFORE and AFTER the migration, then soft-delete,
# tombstone, cascade and compatibility checks. Synthetic data only; never
# touches the project database.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../0007_referral_delete_lockdown.sql"
WORK="$(mktemp -d /tmp/pg0007.XXXXXX)"
PORT="${PORT:-55437}"
PGBIN="$(dirname "$(command -v initdb)")"
cleanup() { "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
RUNAS=""
if [ "$(id -u)" = "0" ]; then
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
ok()  { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1 :: $2"; fail=$((fail+1)); }
eqv() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "got [$2] want [$3]"; fi; }

O=11111111-1111-4111-8111-111111111111   # active clinician, creator of R1, author of N1
X=22222222-2222-4222-8222-222222222222   # former clinician (role revoked), creator of R2, author of N2
C=33333333-3333-4333-8333-333333333333   # active clinician, owns nothing
A=44444444-4444-4444-8444-444444444444   # admin
R1=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1; R2=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2
N1=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1; N2=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2

seed() {
  "${PSQL[@]}" -d "$1" -f "$HERE/base_referrals.sql"
  "${PSQL[@]}" -d "$1" <<SQL
INSERT INTO user_roles(user_id, role) VALUES ('$O','clinician'), ('$C','clinician'), ('$A','admin');
-- X was a clinician when they created R2/N2; the role has since been revoked (no row).
INSERT INTO referrals(id, created_by) VALUES ('$R1','$O'), ('$R2','$X');
INSERT INTO referral_notes(id, referral_id, author_id) VALUES ('$N1','$R1','$O'), ('$N2','$R2','$X');
INSERT INTO referral_note_keys VALUES ('$N1','$O','k'), ('$N1','$C','k'), ('$N2','$X','k'), ('$N2','$C','k');
INSERT INTO referral_tasks(referral_id, title, created_by) VALUES ('$R1','t','$O'), ('$R2','t','$X');
INSERT INTO referral_messages(referral_id, body, sent_by) VALUES ('$R1','m','$O'), ('$R2','m','$X');
INSERT INTO notifications(user_id, referral_id, kind, message) VALUES ('$C','$R1','k','m'), ('$C','$R2','k','m');
INSERT INTO postop_bookings(converted_referral_id) VALUES ('$R1');
CREATE SCHEMA chk;
-- Runs one statement as a client role in a subtransaction, then reports what
-- is left (counted as the owner). Exceptions are reported as SQLSTATE.
CREATE FUNCTION chk.probe(actor uuid, as_role text, stmt text) RETURNS text LANGUAGE plpgsql AS \$f\$
DECLARE n bigint; res text;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', coalesce(actor::text, ''), true);
    EXECUTE format('SET LOCAL ROLE %I', as_role);
    EXECUTE stmt;
    GET DIAGNOSTICS n = ROW_COUNT;
    RESET ROLE;
    res := 'rows=' || n;
  EXCEPTION WHEN OTHERS THEN
    res := 'ERR ' || SQLSTATE;
  END;
  RESET ROLE;
  RETURN res || ' left=' || (SELECT count(*) FROM referrals) || '/' || (SELECT count(*) FROM referral_notes)
    || '/' || (SELECT count(*) FROM referral_note_keys) || '/' || (SELECT count(*) FROM referral_tasks)
    || '/' || (SELECT count(*) FROM referral_messages) || '/' || (SELECT count(*) FROM notifications);
END \$f\$;
SQL
}
# One probe per transaction, always rolled back, so each case starts from the seed.
probe() { "${PSQL[@]}" -d "$1" -c "BEGIN; SELECT chk.probe($2, '$3', \$q\$$4\$q\$); ROLLBACK;" ; }
U() { [ "$1" = "-" ] && echo "NULL" || echo "'$1'::uuid"; }

# Full state = referrals/notes/keys/tasks/messages/notifications = 2/2/4/2/2/2
matrix() { # db label
  local db=$1 L=$2
  local -a CASES=(
    "anon|-|anon|DELETE FROM referrals WHERE id = '$R1'"
    "anon unfiltered|-|anon|DELETE FROM referrals"
    "owner|$O|authenticated|DELETE FROM referrals WHERE id = '$R1'"
    "owner unfiltered|$O|authenticated|DELETE FROM referrals"
    "revoked former owner|$X|authenticated|DELETE FROM referrals WHERE id = '$R2'"
    "revoked former owner unfiltered|$X|authenticated|DELETE FROM referrals"
    "non-owner clinician|$C|authenticated|DELETE FROM referrals WHERE id = '$R1'"
    "non-owner clinician unfiltered|$C|authenticated|DELETE FROM referrals"
    "admin|$A|authenticated|DELETE FROM referrals WHERE id = '$R2'"
    "admin unfiltered|$A|authenticated|DELETE FROM referrals"
    "owner truncate|$O|authenticated|TRUNCATE referrals CASCADE"
    "note: anon|-|anon|DELETE FROM referral_notes"
    "note: author|$O|authenticated|DELETE FROM referral_notes WHERE id = '$N1'"
    "note: revoked author|$X|authenticated|DELETE FROM referral_notes WHERE id = '$N2'"
    "note: revoked author unfiltered|$X|authenticated|DELETE FROM referral_notes"
    "note: non-author clinician unfiltered|$C|authenticated|DELETE FROM referral_notes"
    "note: admin|$A|authenticated|DELETE FROM referral_notes WHERE id = '$N2'"
    "keys: revoked author unfiltered|$X|authenticated|DELETE FROM referral_note_keys"
    "keys: author|$O|authenticated|DELETE FROM referral_note_keys WHERE note_id = '$N1'"
    "keys: non-author clinician unfiltered|$C|authenticated|DELETE FROM referral_note_keys"
  )
  for c in "${CASES[@]}"; do
    IFS='|' read -r name actor role stmt <<<"$c"
    echo "$L | $name | $(probe "$db" "$(U "$actor")" "$role" "$stmt")"
  done
}

createdb before; seed before
createdb after;  seed after
"${PSQL[@]}" -1 -d after -f "$MIG"
ok "0007 applies in one transaction"

matrix before BEFORE > "$WORK/before.txt"
matrix after AFTER > "$WORK/after.txt"
cat "$WORK/before.txt" "$WORK/after.txt"

res() { grep -F "$1 | $2 |" "$WORK/$( [ "$1" = BEFORE ] && echo before || echo after ).txt" | sed 's/.* | //'; }

# ---- BEFORE: confirm (or refute) the reported exposure, by observation -----
eqv "before: anon refused"                         "$(res BEFORE anon)"                               "ERR 42501 left=2/2/4/2/2/2"
eqv "before: owner hard-deletes R1 + cascades"     "$(res BEFORE owner)"                              "rows=1 left=1/1/2/1/1/1"
eqv "before: revoked owner filtered sees nothing"  "$(res BEFORE 'revoked former owner')"             "rows=0 left=2/2/4/2/2/2"
eqv "before: revoked owner UNFILTERED deletes R2"  "$(res BEFORE 'revoked former owner unfiltered')"  "rows=1 left=1/1/2/1/1/1"
eqv "before: non-owner clinician 0"                "$(res BEFORE 'non-owner clinician unfiltered')"   "rows=0 left=2/2/4/2/2/2"
eqv "before: admin hard-deletes all"               "$(res BEFORE 'admin unfiltered')"                 "rows=2 left=0/0/0/0/0/0"
eqv "before: owner TRUNCATE succeeds (RLS-free)"   "$(res BEFORE 'owner truncate')"                   "rows=0 left=0/0/0/0/0/0"
eqv "before: revoked author unfiltered note delete" "$(res BEFORE 'note: revoked author unfiltered')" "rows=1 left=2/1/2/2/2/2"
eqv "before: revoked author filtered note delete 0" "$(res BEFORE 'note: revoked author')"            "rows=0 left=2/2/4/2/2/2"
# Observed (not the reported hypothesis): wrapped keys were already safe — the
# key policy's EXISTS on referral_notes is itself filtered by the notes SELECT
# policy (clinical access), so a revoked author matches nothing. 0007 makes
# this explicit rather than incidental.
eqv "before: revoked author key delete already 0 (via notes SELECT RLS)" "$(res BEFORE 'keys: revoked author unfiltered')"  "rows=0 left=2/2/4/2/2/2"

# ---- AFTER: no client hard delete of referrals at all --------------------
for n in anon "anon unfiltered" owner "owner unfiltered" "revoked former owner" "revoked former owner unfiltered" \
         "non-owner clinician" "non-owner clinician unfiltered" admin "admin unfiltered" "owner truncate"; do
  eqv "after: referrals $n refused" "$(res AFTER "$n")" "ERR 42501 left=2/2/4/2/2/2"
done
eqv "after: note anon refused"                     "$(res AFTER 'note: anon')"                          "ERR 42501 left=2/2/4/2/2/2"
eqv "after: note author deletes own (keys cascade)" "$(res AFTER 'note: author')"                       "rows=1 left=2/1/2/2/2/2"
eqv "after: note revoked author 0"                 "$(res AFTER 'note: revoked author')"                "rows=0 left=2/2/4/2/2/2"
eqv "after: note revoked author unfiltered 0"      "$(res AFTER 'note: revoked author unfiltered')"     "rows=0 left=2/2/4/2/2/2"
eqv "after: note non-author clinician 0"           "$(res AFTER 'note: non-author clinician unfiltered')" "rows=0 left=2/2/4/2/2/2"
eqv "after: note admin deletes (keys cascade)"     "$(res AFTER 'note: admin')"                         "rows=1 left=2/1/2/2/2/2"
eqv "after: keys revoked author unfiltered 0"      "$(res AFTER 'keys: revoked author unfiltered')"     "rows=0 left=2/2/4/2/2/2"
eqv "after: keys author replaces own (edit flow)"  "$(res AFTER 'keys: author')"                        "rows=2 left=2/2/2/2/2/2"
eqv "after: keys non-author clinician 0"           "$(res AFTER 'keys: non-author clinician unfiltered')" "rows=0 left=2/2/4/2/2/2"

# ---- AFTER: native soft delete / restore, tombstone, cascades, compat -----
SOFT="UPDATE referrals SET deleted_at = now(), deleted_by = '$O' WHERE id = '$R1' AND deleted_at IS NULL"
eqv "soft delete by owner" "$(probe after "'$O'" authenticated "$SOFT")" "rows=1 left=2/2/4/2/2/2"
eqv "soft delete by admin" "$(probe after "'$A'" authenticated "UPDATE referrals SET deleted_at = now(), deleted_by = '$A' WHERE id = '$R1'")" "rows=1 left=2/2/4/2/2/2"
eqv "soft delete by non-owner clinician refused" "$(probe after "'$C'" authenticated "UPDATE referrals SET deleted_at = now(), deleted_by = '$C' WHERE id = '$R1'")" "ERR 42501 left=2/2/4/2/2/2"
eqv "soft delete by revoked former owner 0" "$(probe after "'$X'" authenticated "UPDATE referrals SET deleted_at = now(), deleted_by = '$X' WHERE id = '$R2'")" "rows=0 left=2/2/4/2/2/2"
eqv "soft delete by anon refused" "$(probe after NULL anon "$SOFT")" "ERR 42501 left=2/2/4/2/2/2"

# Persist a soft delete, then read the tombstone the way the ?sync=1 feed does
# (service role, deleted rows included) and check nothing cascaded.
"${PSQL[@]}" -d after -c "BEGIN; SET LOCAL request.jwt.claim.sub = '$O'; SET LOCAL ROLE authenticated; $SOFT; COMMIT;"
eqv "tombstone: row kept with deleted_at/deleted_by + newer updated_at" \
  "$("${PSQL[@]}" -d after -c "SET ROLE service_role; SELECT (deleted_at IS NOT NULL)::text || '|' || deleted_by || '|' || (updated_at > created_at)::text FROM referrals WHERE id = '$R1'")" "true|$O|true"
eqv "tombstone: notes/keys/tasks/messages/notifications/booking link intact" \
  "$("${PSQL[@]}" -d after -c "SELECT (SELECT count(*) FROM referral_notes WHERE referral_id='$R1') || '/' || (SELECT count(*) FROM referral_note_keys WHERE note_id='$N1') || '/' || (SELECT count(*) FROM referral_tasks WHERE referral_id='$R1') || '/' || (SELECT count(*) FROM referral_messages WHERE referral_id='$R1') || '/' || (SELECT count(*) FROM notifications WHERE referral_id='$R1') || '/' || (SELECT count(*) FROM postop_bookings WHERE converted_referral_id='$R1')")" "1/2/1/1/1/1"
eqv "deleted row still visible to its creator (restore list)" "$(probe after "'$O'" authenticated "SELECT 1 FROM referrals WHERE id = '$R1' AND deleted_at IS NOT NULL")" "rows=1 left=2/2/4/2/2/2"
eqv "deleted row hidden from non-owner clinician" "$(probe after "'$C'" authenticated "SELECT 1 FROM referrals WHERE id = '$R1'")" "rows=0 left=2/2/4/2/2/2"
eqv "restore by owner" "$(probe after "'$O'" authenticated "UPDATE referrals SET deleted_at = NULL, deleted_by = NULL, updated_by = '$O' WHERE id = '$R1'")" "rows=1 left=2/2/4/2/2/2"
eqv "restore by non-owner clinician 0" "$(probe after "'$C'" authenticated "UPDATE referrals SET deleted_at = NULL, deleted_by = NULL WHERE id = '$R1'")" "rows=0 left=2/2/4/2/2/2"

eqv "compat: clinician inserts a referral" "$(probe after "'$C'" authenticated "INSERT INTO referrals(created_by) VALUES ('$C')")" "rows=1 left=3/2/4/2/2/2"
eqv "compat: clinician edits a live referral" "$(probe after "'$C'" authenticated "UPDATE referrals SET status = 'accepted' WHERE id = '$R2'")" "rows=1 left=2/2/4/2/2/2"
eqv "compat: author edits own note" "$(probe after "'$O'" authenticated "UPDATE referral_notes SET edited_at = now() WHERE id = '$N1'")" "rows=1 left=2/2/4/2/2/2"
eqv "compat: admin still deletes tasks/messages" "$(probe after "'$A'" authenticated "DELETE FROM referral_tasks")" "rows=2 left=2/2/4/0/2/2"
eqv "operator: service_role can still hard-delete (cascades)" "$(probe after NULL service_role "DELETE FROM referrals WHERE id = '$R2'")" "rows=1 left=1/1/2/1/1/1"
eqv "grants: authenticated has no DELETE/TRUNCATE on referrals" \
  "$("${PSQL[@]}" -d after -c "SELECT has_table_privilege('authenticated','public.referrals','DELETE')::text || has_table_privilege('authenticated','public.referrals','TRUNCATE')::text || has_table_privilege('anon','public.referrals','DELETE')::text")" "falsefalsefalse"
eqv "grants: authenticated keeps SELECT/INSERT/UPDATE on referrals, DELETE on notes" \
  "$("${PSQL[@]}" -d after -c "SELECT has_table_privilege('authenticated','public.referrals','SELECT,INSERT,UPDATE')::text || has_table_privilege('authenticated','public.referral_notes','DELETE')::text")" "truetrue"
eqv "trigger refuses even if DELETE is re-granted" \
  "$("${PSQL[@]}" -d after -c "BEGIN; GRANT DELETE ON referrals TO authenticated; CREATE POLICY tmp ON referrals FOR DELETE TO authenticated USING (true); SELECT chk.probe('$A', 'authenticated', 'DELETE FROM referrals'); ROLLBACK;")" "ERR 42501 left=2/2/4/2/2/2"

# ---- the app's RETURNING forms (shipped before 0007) work on both schemas ---
# Undo the persisted tombstone above so both schemas start from the seed state.
"${PSQL[@]}" -d after -c "SET request.jwt.claim.sub = '$O'; UPDATE referrals SET deleted_at = NULL, deleted_by = NULL WHERE id = '$R1'"
for db in before after; do
  eqv "$db: owner soft delete RETURNING id" "$(probe $db "'$O'" authenticated "UPDATE referrals SET deleted_at = now(), deleted_by = '$O' WHERE id = '$R1' AND deleted_at IS NULL RETURNING id")" "rows=1 left=2/2/4/2/2/2"
  eqv "$db: admin soft delete of another's referral RETURNING id" "$(probe $db "'$A'" authenticated "UPDATE referrals SET deleted_at = now(), deleted_by = '$A' WHERE id = '$R2' AND deleted_at IS NULL RETURNING id")" "rows=1 left=2/2/4/2/2/2"
  eqv "$db: author note delete RETURNING id" "$(probe $db "'$O'" authenticated "DELETE FROM referral_notes WHERE id = '$N1' RETURNING id")" "rows=1 left=2/1/2/2/2/2"
  eqv "$db: revoked author note delete RETURNING 0 rows" "$(probe $db "'$X'" authenticated "DELETE FROM referral_notes WHERE id = '$N2' RETURNING id")" "rows=0 left=2/2/4/2/2/2"
done
"${PSQL[@]}" -d after -c "SET request.jwt.claim.sub = '$O'; UPDATE referrals SET deleted_at = now(), deleted_by = '$O' WHERE id = '$R1'"
eqv "after: owner restore RETURNING id" "$(probe after "'$O'" authenticated "UPDATE referrals SET deleted_at = NULL, deleted_by = NULL, updated_by = '$O' WHERE id = '$R1' RETURNING id")" "rows=1 left=2/2/4/2/2/2"

# ---- preflight: drifted policy name refuses and applies nothing ------------
createdb drift; seed drift
"${PSQL[@]}" -d drift -c "ALTER POLICY \"Notes deletable by author or admin\" ON referral_notes RENAME TO renamed"
if out=$("${PSQL[@]}" -1 -d drift -f "$MIG" 2>&1); then bad "preflight on drift" "applied"; else
  [[ "$out" == *"0007 preflight"* ]] && ok "preflight refuses drifted policies" || bad "preflight on drift" "$out"; fi
eqv "drift: nothing applied" "$("${PSQL[@]}" -d drift -c "SELECT has_table_privilege('authenticated','public.referrals','DELETE')::text || (to_regprocedure('public.referrals_refuse_client_hard_delete()') IS NULL)::text")" "truetrue"

echo "== $pass passed, $fail failed"
[ "$fail" = 0 ]
