# Staged database changes — NOT applied

These files are reviewed SQL for the coordinated CCC + ICU Handover Hub
release. They are deliberately outside `drizzle/migrations/` so nothing
applies them automatically. At release, apply each (in number order) as a
new migration, then regenerate types.

| File | What it does | App behaviour until applied |
|---|---|---|
| 0003_wardable_revision_fence.sql | Durable per-patient wardable revision counter, `set_wardable_desired_state()` (actor = auth.uid()), guard against direct edits of wardable/revision/sync fields | Wardable toggles save the LOCAL timer only (revision kept in the row) and never call the Hub; the card shows "Hub not updated" and the migration backfills the counter from those rows |
| 0004_acuity_revision_and_audit.sql | DB-managed strictly increasing acuity revision + actor; history/audit record effective nullable level, real 1:1 and level_recorded | App-side compare-and-set on the exact revision already works; the app moves updated_at strictly forward itself |
| 0005_capacity_alert_claim.sql | Atomic capacity-alert claim (state CAS + in-app notifications + event row), delivery recording | Capacity alerts are suppressed ("claim_unavailable"); capacity numbers on screen are unaffected |
