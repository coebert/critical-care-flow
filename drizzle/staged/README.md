# Staged database changes — NOT applied

These files are reviewed SQL for the coordinated CCC + ICU Handover Hub
release. They are deliberately outside `drizzle/migrations/` so nothing
applies them automatically. At release, apply each (in number order) as a
new migration, then regenerate types.

| File | What it does | App behaviour until applied |
|---|---|---|
| 0003_wardable_revision_fence.sql | Durable per-patient wardable revision counter, `set_wardable_desired_state()` (actor = auth.uid()), guard against direct edits of wardable/revision/sync fields | Wardable toggles save the LOCAL timer only (revision kept in the row) and never call the Hub; the card shows "Hub not updated" and the migration backfills the counter from those rows |
| 0004_acuity_revision_and_audit.sql | DB-managed strictly increasing acuity revision + actor; history/audit record effective nullable level, real 1:1 and level_recorded | App-side compare-and-set on the exact revision already works; the app moves updated_at strictly forward itself |
| 0006_wardable_reviewed_intent.sql | `confirm_wardable_reviewed_intent()`: after the Hub applied a revision and its value then changed natively, a reviewed confirmation allocates a NEW revision only if the local revision/value are still the reviewed ones (requires 0003) | Review confirmations of that case report "paused until release" and send nothing; other reviewed re-sends are already paused until 0003 |
| 0005_capacity_alert_claim.sql | Atomic capacity-alert claim (state CAS + in-app notifications + event row), delivery recording | Capacity alerts are suppressed ("claim_unavailable"); capacity numbers on screen are unaffected |
| 0007_referral_delete_lockdown.sql | Client roles can no longer hard-delete or truncate referrals (DELETE/TRUNCATE revoked, DELETE policy dropped, refusing trigger kept as a backstop); deleting a note or its wrapped keys also needs current clinical access. Preflight refuses if the three reviewed policies have drifted. | Native app already only soft-deletes/restores referrals and now audits only when the database confirms a row changed. Until applied, a creator/admin can still hard-delete through the Data API, and a revoked former author can still hard-delete their notes with a filter-free DELETE |

Disposable check (synthetic, local throwaway Postgres; never the project database):
`bash drizzle/staged/checks/0003_check.sh` — applies 0003 then 0006 and runs grant, CAS, >2^53, overflow, rollback, actor and concurrency checks.
`bash drizzle/staged/checks/0007_check.sh` — builds copies of the live referral grants/policies/triggers (`base_referrals.sql`), runs the same DELETE matrix (anon, active creator, revoked former creator, non-owner clinician, admin; filtered and filter-free; TRUNCATE) BEFORE and AFTER 0007, then soft delete/restore, tombstone, cascade, compatibility, operator and drift-preflight checks.

## Release order (exact)

Run each step only after the previous one succeeded. Each SQL file is applied as its own migration, in one transaction, unchanged.

1. Re-run both disposable checks on the release commit: `0003_check.sh` (covers 0003 + 0006) and `0007_check.sh`. Both must report 0 failed.
2. Apply `0003_wardable_revision_fence.sql`.
3. Apply `0004_acuity_revision_and_audit.sql`.
4. Apply `0005_capacity_alert_claim.sql`.
5. Apply `0006_wardable_reviewed_intent.sql` (needs 0003).
6. Apply `0007_referral_delete_lockdown.sql`. It does not depend on 0003–0006; it goes last so the apply order matches the review order. If its preflight raises, stop: the live policies differ from the ones reviewed.
7. Regenerate the database types. Then run these read-only checks:
   - `SELECT has_table_privilege('authenticated','public.referrals','DELETE'), has_table_privilege('authenticated','public.referrals','TRUNCATE')` returns `false, false`.
   - `SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.referrals'::regclass AND tgname LIKE 'referrals_refuse_client_%'` returns two rows.
   - `SELECT pg_get_expr(polqual, polrelid) FROM pg_policy WHERE polrelid IN ('public.referral_notes'::regclass, 'public.referral_note_keys'::regclass) AND polcmd = 'd'` shows `has_clinical_access(auth.uid())` in both.
8. Hub side: deploy `POST /patients/wardable` and the `deleted_at` tombstone/live import, and set the Hub's `PARTNER_BRIDGE_URL` to the CCC published origin (see `docs/release/hub-inbound-pull-config.md`).
9. Publish CCC. Then confirm `GET /api/public/bridge/health` reports `runtime: "published"`, and that the next Hub pull logs 3 × `?sync=1&limit=500 → 200`.

The CCC app code in this commit works both before and after steps 2–6. `0007_check.sh` runs its referral soft-delete, restore and note-delete calls against both schemas.
