# HMAC bridge with ICU Compass — full parity build

## Scope
Build both sides of the signed bridge on this app: inbound receiver + outbound sync client, using the exact scheme the ICU Compass agent published (HMAC-SHA256 over `${ts}.${actor}.${rawBody}`, headers `x-timestamp` / `x-actor` / `x-signature`, 300s skew, actor RBAC = admin|clinician, shared secret `HANDOVER_API_SECRET` with `_PREVIOUS` rotation support).

## Secrets
- Generate `HANDOVER_API_SECRET` here (64 chars). Deliver the value to you once so you can paste the identical value into ICU Compass.
- Add `PARTNER_BRIDGE_URL` = `https://icu-compass-care.lovable.app/api/public/bridge` (settable via secure form; defaults handled if unset).
- Optional `HANDOVER_API_SECRET_PREVIOUS` supported at verify time for zero-downtime rotation.

## Shared library
`src/lib/bridge-hmac.server.ts` — pure sign/verify helpers, timing-safe compare, timestamp skew check, actor JSON parse, dual-secret verify. Unit tests in `src/lib/bridge-hmac.test.ts`.

## Inbound endpoints — `src/routes/api/public/bridge/*`
Each route: OPTIONS (CORS 204), GET + POST as listed. All handlers verify signature first, then check actor role, then dispatch. Errors return JSON `{error}` with CORS headers.

| Path | GET | POST |
|---|---|---|
| `/health` | liveness + secret-configured flag | — |
| `/verify-signature` | self-test (signs a canned body with server secret and returns proof) | verifies caller's signature against submitted body, returns `{valid:true}` |
| `/patients` | list (filter `?status=`) | upsert by `id`; optimistic concurrency via `expected_updated_at` → 409 with current row |
| `/investigations` | list (filter `?patient_id=`) | upsert |
| `/microbiology` | list | upsert |
| `/referrals` | list | upsert |
| `/notifications` | list (own actor) | insert |
| `/audit` | list (paged, admin actor only) | — |

DB writes use `supabaseAdmin` (loaded inside handler) since the bridge caller is a machine principal, not an auth.uid; every write records to `audit_log` with `user_id = actor.id` when the actor id resolves to a real user, otherwise null + `diff.actor` preserved.

## Schema additions
Two tables this project doesn't have yet:
- `public.microbiology` (id, patient_id fk, organism, sample_type, sensitivities jsonb, sampled_at, reported_at, notes, created_by, created_at, updated_at) + RLS + GRANTs.
- `public.bridge_sync_state` (resource text PK, last_pulled_at timestamptz, last_pushed_at timestamptz, last_error text, last_error_at timestamptz) — cursor for the sync worker.

Patients table already has 31 columns; the receiver maps the documented payload shape onto existing columns and rejects unknown fields.

## Outbound sync — `src/routes/api/public/bridge/sync.ts`
Cron-triggered POST. For each resource:
1. Read `bridge_sync_state.last_pulled_at`.
2. GET `${PARTNER_BRIDGE_URL}/<resource>?since=<iso>` with signed headers (actor = system admin principal).
3. Upsert incoming rows via the same code path as the inbound handler (so validation is identical).
4. Read rows updated locally since `last_pushed_at`, POST them to the partner in batches.
5. Update `bridge_sync_state`; on partial failure record `last_error` but continue other resources.

pg_cron job runs every 2 minutes calling `/api/public/bridge/sync` with `apikey` header (per project convention).

## Files created
```
src/lib/bridge-hmac.server.ts
src/lib/bridge-hmac.test.ts
src/lib/bridge-actor.ts                  # actor validation + role check
src/lib/bridge-cors.ts
src/lib/bridge-repo.server.ts            # per-resource read/upsert helpers, shared by receiver + sync
src/routes/api/public/bridge/health.ts
src/routes/api/public/bridge/verify-signature.ts
src/routes/api/public/bridge/patients.ts
src/routes/api/public/bridge/investigations.ts
src/routes/api/public/bridge/microbiology.ts
src/routes/api/public/bridge/referrals.ts
src/routes/api/public/bridge/notifications.ts
src/routes/api/public/bridge/audit.ts
src/routes/api/public/bridge/sync.ts
supabase/migrations/<ts>_bridge_tables.sql
```

## Verification
1. `curl` `/bridge/health` — 200.
2. `curl -XPOST /bridge/verify-signature` with a locally-signed body — 200 `{valid:true}`.
3. `curl -XPOST /bridge/patients` upsert — new row appears in `patients`; second call with stale `expected_updated_at` → 409.
4. Manual `/bridge/sync` invocation logs pull/push counts; `bridge_sync_state` rows populated.
5. After you paste the same secret into ICU Compass, hit their `/verify-signature` from this app's sync worker — round-trip proven.

## Phased delivery
Because this is large, I will land it in this order and stop for you to confirm after each phase:
1. **Phase 1** — secret + shared HMAC library + `/health` + `/verify-signature` + migration for `microbiology` and `bridge_sync_state`. This is enough for the two agents to prove signing works.
2. **Phase 2** — `/patients` + `/investigations` + `/microbiology` receivers.
3. **Phase 3** — `/referrals` + `/notifications` + `/audit` receivers.
4. **Phase 4** — outbound sync worker + pg_cron schedule.

Confirm and I'll execute Phase 1.
