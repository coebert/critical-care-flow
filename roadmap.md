# Roadmap — capacity integrity release (paired with ICU Handover Hub; do not publish)

- [x] 1. Single authoritative capacity model (partner occupancy + CCC acuity + staffing) for Bed Board, TV board, referral badge/callout/mini link and alerts; stale/unknown handling; 20s refresh + focus recovery; alert suppression
- [x] 2. Strict partner payload validation; occupied-with-withheld-occupant renders occupied everywhere
- [x] 3. Server-side clinical role guard before signed partner fetch
- [x] 4. Remove patient identifiers from bed-board links (opaque id + neutral label, guarded context load)
- [x] 5. Central Europe/London shift clock (day 08–20, night 20–08, prior date before 08:00)
- [x] 6. UI review (phone/tablet/desktop, labels, non-colour status, loading/error/retry)
- [x] Tests, typecheck, build, mocked-layout checks, commit
- [ ] Confirm Hub's indeterminate/failure field names (waiting on Hub contract confirmation)
- [ ] Publish together with Hub (waiting on paired release)
