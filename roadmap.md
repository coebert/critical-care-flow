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

Open (blocked on paired release / Hub):
- [ ] Apply staged SQL `drizzle/staged/0003–0005` at the coordinated release (until then: wardable saves locally only, alerts suppressed)
- [ ] Hub deploys `POST /patients/wardable` and the deleted_at tombstone/live import
- [ ] Confirm Hub patient link path `<Hub site>/patients/<id>`
- [ ] Publish together with Hub
