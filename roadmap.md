# Roadmap — paired integration fixes (CCC only; do not publish)

Done earlier: shared capacity model, withheld occupant, server role guard, identifier-free links, shift clock, UI review.

- [ ] A. Hub bed contract: generated_at, unit_code SDH-RADNOR / label scope, stats.unassigned hidden → demand unknown, source-stale detection, request timeout, missing level → indeterminate (1:1 known = 1.0)
- [ ] B. Bridge GET sync=1 envelope (patients, investigations, referrals, microbiology): cursor, snapshot fence, tombstones, referral created_at/updated_at, micro canonical mapping; default GET unchanged
- [ ] C. BedCard hooks split + test; TV pending referrals loading/empty/error/stale; staffing blank≠0, failed save keeps draft
- [ ] D. Session-scoped query cache: clear on signout/identity change/role denial; old fetch can't populate new user
- [ ] E. Handover prefill: fresh Hub GET by id, verified linkage, preview + confirm, revision-bound apply with expected_updated_at, preserve explicit false, no DNACPR/TEP inference, labelled source text
- [ ] F. setPatientAcuity fail closed + CAS / field merge; acuity save re-evaluates capacity alerts
- [ ] G. Ward-round print from Hub snapshot with source age/unknown
- [ ] H. Wardable/discharge truthfulness: typed sync outcome, fresh revision partial patch, mismatch reconstruction, latest-only retry; discharge = local timing only + Hub link
- [ ] Tests (functional), typecheck, full tests, build, phone/tablet/desktop fixture layouts, commit
