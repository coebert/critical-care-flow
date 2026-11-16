# Roadmap — paired Hub/CCC integration (CCC only; do not publish until paired release)

Done (synthetic tests pass, not published):
- [x] A–H paired fixes (contract v2, sync=1 feed, BedCard/TV/staffing, session cache, prefill, acuity, ward round, wardable/discharge truthfulness)
- [x] 1. Referral feed: live records carry `deleted_at:null`; tombstones stay `{id,updated_at,deleted_at}`
- [x] 2. Wardable: signed `POST /patients/wardable` with durable per-patient revisions; no generic POST fallback; review-before-retry
- [x] 3. Acuity: exact-revision CAS (no Date.parse identity); audit/history triggers aligned (staged SQL)
- [x] 4. Capacity freshness ages board + acuity + staffing; strict occupant DTO; no raw upstream errors
- [x] 5. Capacity alerts fail closed; atomic claim + in-app notifications (staged SQL); push partial delivery recorded
- [x] 6. Old two-way mirror sync retired (no mutations); 1-min cron re-checks capacity via guarded alert path
- [x] 7. Bed board "Load latest" rebases form and target revision
- [x] 8. Full tests, typecheck, build, synthetic phone/tablet/desktop flows; ward-round page made reachable

Final correction pass (on 6dbb4c0):
- [x] A. Clear/unmount all clinical UI state on denial/logout/identity change; stale-reply guards for edit/acuity/prefill/retry; referrals in purge roots; shared denial gate
- [x] B. Wardable revisions as lossless decimal strings end-to-end; canonical lowercase patient ids; protected durable counter (staged SQL + disposable SQL checks)
- [x] C. Hub wire semantics: 409 revision rules, PG bigint max, 404 not_found = not shared, target_changed = review conflict
- [x] C (part). Missing optional outlier/transfer feeds show as "not available", not 0 (synthetic browser check)
- [x] B/C wire + bigint (committed f4dca4a)
- [x] 1. Clinical UI purge on denial/logout/identity change; ['referrals'] purge; late async guards; mounted tests
- [x] 2. Wardable review-confirm bound to user/patient/local revision/Hub CAS (signed token); new durable revision conditional on reviewed revision; tests
- [x] D. Functional handler tests for Hub patient writes (sanitised, private errors, scope/revoked, partial update, stale CAS)
- [x] Full tests, typecheck, build, commit
- [x] Signed-in synthetic phone/desktop browser checks (all server/data replies stubbed; no real account or patient data)

Open (blocked on paired release / Hub):
- [x] Re-audit 6472350: /auth hydration #418 (signed-out "/" redirect mid-hydration) fixed via hydration gate
- [x] "Keep me signed in" off: honoured on password + passkey, reload, refresh, browser close, sign-out
- [x] Post-sign-in redirect: strict internal-path validation (router merged raw search; external nav possible)
- [x] Expired reset link: keyboard way back to sign-in
- [x] Bed board: late rollback/toast after denial; older confirm closing newer review; clock-back capacity freshness; truthful unknown Hub outcome text
- [x] Follow-on A: inbound bridge POST writes (referrals, investigations, microbiology, patients, beds, bed_*) retired with signed 410 refusal; tests
- [x] Follow-on B: Hub pull `partner_http_error` diagnosed CCC-side (requests never reach CCC); health reports runtime + contract; fix staged in docs/release/hub-inbound-pull-config.md
- [ ] Hub: set PARTNER_BRIDGE_URL to the CCC published origin at release (Hub-side config, needs approval)
- [x] Referral hard-delete lockdown + clinical-access note deletion staged as 0007 (disposable check 61/61); app soft delete/restore/note delete audit only confirmed rows
- [ ] Apply staged SQL `drizzle/staged/0003–0007` at the coordinated release (until then: wardable saves locally only, alerts suppressed)
- [ ] Hub deploys `POST /patients/wardable` and the deleted_at tombstone/live import
- [ ] Publish together with Hub
