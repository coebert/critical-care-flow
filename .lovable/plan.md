# DTAC compliance plan — SDH Critical Care

DTAC (NHS Digital Technology Assessment Criteria, v3) has five assessed areas: **Clinical Safety (DCB0129)**, **Data Protection (UK GDPR / DPA 2018)**, **Technical Assurance (Cyber Essentials + NCSC)**, **Interoperability (NHS data standards)** and **Usability & Accessibility (WCAG 2.2 AA / NHS Service Manual)**. Parts of DTAC are organisational documents you (the manufacturer) sign — I cannot produce those on your behalf, but I can build every technical control they reference and generate the in-app artefacts and public pages the assessor looks for.

## Current state (what I observed)

Strengths already in the code:

- Auth: email/password + passkeys, throttling RPC (`begin_auth_attempt` / `finalize_auth_attempt`), reset-password page, HIBP compatible.
- RLS on every user-data table; roles in `user_roles` via `has_role`.
- Hospital number stored as `hospital_number_enc` + salted `hospital_number_hash` (no plaintext identifier at rest).
- End-to-end encrypted referral notes (X25519 sealed box) enforced app-wide; legacy plaintext writes gated behind `ALLOW_NON_E2E_NOTES`.
- Audit log for admin actions, keypair lifecycle, and E2E note events.
- Push notifications with per-user subscriptions and signed VAPID.

Gaps against DTAC:

| Area | Gap |
|---|---|
| Clinical safety | No DCB0129 hazard log, no clinical safety case, no in-app CSO contact, no "known issues / safety notices" page |
| Data protection | No public privacy notice, cookie notice, DPIA link, ROPA reference, SAR contact, retention statement |
| Technical assurance | No idle-session timeout, no visible security.txt/vuln disclosure, no security headers configured, no documented backup / DR statement, MFA not enforced for clinicians, password policy not stated, no `SECURITY.md` |
| Interoperability | No NHS Number capture/validation (Mod 11), no ODS/organisation code, no SNOMED CT for reason-for-referral / specialty, no FHIR export, no dm+d for drugs (if used) |
| Usability & accessibility | No published accessibility statement, no skip-link, focus/landmark audit not done, colour-contrast/theming not verified against WCAG 2.2 AA, no reduced-motion respect, forms lack explicit error-summary pattern |

---

## Phased plan

Each phase ends in a working state I can ship independently. Phases 3–5 are the ones that most need your input (org-specific facts, CSO name, ODS code, etc.); I'll ask inline as we get to them.

### Phase 1 — Technical assurance quick wins  *(code only, no user input)*

1. **Idle session timeout** — configurable auto-signout (default 30 min inactivity, 12 h absolute) with a 60-second "you'll be signed out" warning modal. Timer resets on real activity (pointer/keyboard/visibility), not on background polling.
2. **Security headers** — set CSP, `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options: DENY` via `src/routes/__root.tsx` head + a server route helper.
3. **Password policy** — enable Supabase HIBP check (via `configure_auth`), enforce ≥12 chars + complexity in the sign-up/reset UI, surface the rules in the field help text.
4. **Enforce MFA for clinician / admin roles** — after first sign-in, gate protected routes behind either an enrolled passkey OR a TOTP factor. Existing passkey enrol prompt becomes a hard block for admins after a grace period.
5. **`SECURITY.md` + `/.well-known/security.txt`** — coordinated disclosure contact, PGP fingerprint slot, scope. Served from a public route.
6. **Rate limit audit** — extend the existing auth throttle pattern to password-reset, passkey challenge, and E2E unlock endpoints.
7. **Dependency + secret hygiene** — run `code--dependency_scan`, patch anything critical/high; add a `docs/SECURE_DEVELOPMENT.md` capturing SDLC (code review, CI, secret handling).

### Phase 2 — Data protection & transparency  *(needs a few org facts from you)*

1. **Public routes** (all top-level, indexed, WCAG-clean):
   - `/privacy` — data controller, lawful basis (public task / Art. 9(2)(h) for health data), categories of personal data, retention, recipients, SAR contact, ICO complaints route.
   - `/cookies` — the app only uses first-party session storage + service-worker cache; no analytics cookies — state it plainly.
   - `/accessibility` — WCAG 2.2 AA conformance statement, known issues, contact, review date.
   - `/terms` — acceptable use, clinician responsibilities, incident reporting.
   - `/trust` — index page linking the above + a plain-English summary of the E2E encryption model.
2. **In-app data-subject rights** — "Download my data" and "Delete my account" buttons on `/profile` that call new authenticated server functions; deletions are soft with a 30-day purge job.
3. **DPIA scaffold** — `docs/dpia.md` template pre-filled with everything I can see from the code (data flows, subprocessors, encryption, retention). You complete the residual-risk section.
4. **ROPA scaffold** — `docs/ropa.md` with data categories, purposes, recipients, transfers, retention.
5. **Retention & purge job** — cron server route that soft-deletes referrals older than the configured retention window and hard-deletes soft-deleted rows after 30 days; retention values live in a config table so you can change them without a deploy.

### Phase 3 — Clinical safety (DCB0129)  *(needs your Clinical Safety Officer)*

1. **In-app CSO contact & incident reporting** — footer link + `/clinical-safety` page listing the named CSO, their contact route, and a "Report a clinical safety issue" form that opens an authenticated server-fn ticket (writes to a new `clinical_safety_reports` table with RLS: reporter can read own, admin can read all).
2. **Hazard log scaffold** — `docs/hazard-log.md` seeded with the hazards implicit in this app (wrong-patient risk, delayed referral due to notification failure, note misdirection, E2E key loss, session hijack). Each hazard: initial severity/likelihood, mitigations already in code (cross-referenced), residual risk. You review and sign.
3. **Clinical safety case template** — `docs/clinical-safety-case.md` following DCB0129 §5.
4. **"Known issues / safety notices" page** — user-visible, admin-editable, so field-safety notices reach clinicians without an email chain.
5. **Wrong-patient safeguards in code** — when composing a referral or booking, show a mandatory confirm-patient step (NHS Number + first-line-of-address or DOB) before submission; audit-log the confirmation.

### Phase 4 — Interoperability  *(needs your ODS code and clinical vocabulary decisions)*

1. **NHS Number** — add a validated `nhs_number` field (Mod 11 checksum, 10 digits, formatted `NNN NNN NNNN`) to referrals and post-op bookings. Store encrypted + hashed like `hospital_number`. Keep hospital number as a secondary identifier.
2. **ODS organisation code** — add `ods_code` to the org profile / config, surface it in exports and the referral audit trail.
3. **SNOMED CT lookup** for `reason_for_referral` and `referring_specialty` — start with a curated local subset (JSON dataset committed to the repo) with typeahead; upgrade path to the NHS terminology server is left as a follow-up.
4. **FHIR R4 UK Core export** — read-only `GET /api/public/fhir/ServiceRequest/{id}` (bearer-gated) that returns a `ServiceRequest` + `Patient` + `Practitioner` bundle for a referral, so downstream systems can pull.
5. **Structured discharge / booking output** — CSV + FHIR `Encounter` export from the post-op bookings analytics page.

### Phase 5 — Usability & accessibility (WCAG 2.2 AA)

1. **Landmark & skip-link pass** — add `<a href="#main">Skip to main content</a>`, ensure `main`, `nav`, `header`, `footer` landmarks and unique `h1` per route.
2. **Focus management** — visible focus ring on every interactive element (Tailwind ring utilities), focus-trap in dialogs (already true via Radix — verify), restore focus on close.
3. **Colour contrast audit** — run automated (axe) + manual pass; fix any token below 4.5:1 (or 3:1 for large text and UI components).
4. **Reduced motion** — wrap animations in `@media (prefers-reduced-motion: reduce)`.
5. **Error summaries** — every form gets a top-of-form error summary linking to invalid fields (NHS Service Manual pattern).
6. **Screen-reader status announcements** — `aria-live` regions for encryption status, notification arrival, and save success.
7. **NHS Service Manual alignment** — align typography scale, spacing, and button styles with NHS design system tokens (without adopting the NHS logo).
8. **Automated a11y tests** — add `@axe-core/react` in dev + a Playwright axe scan on the top 5 routes; wire into CI signal.

### Phase 6 — Assurance evidence bundle

1. `docs/dtac/README.md` — index of every artefact with the DTAC section it satisfies.
2. Auto-generated evidence: RLS policy dump, server-function inventory, dependency SBOM (`bun x @cyclonedx/cyclonedx-npm`), route map, encryption model diagram.
3. Penetration test scope document + fix-tracker template.
4. Cyber Essentials self-assessment checklist mapped to concrete controls in this repo.

---

## Technical details

- **Session timeout implementation:** a `useIdleTimeout` hook that listens to `pointerdown`, `keydown`, `visibilitychange` and persists the last-activity timestamp per-tab in `sessionStorage`; a `BroadcastChannel` message keeps sibling tabs in sync so activity in one keeps all alive. On expiry: clear the E2E session (`useE2ESession.getState().clear()`), `supabase.auth.signOut()`, redirect to `/auth?reason=timeout`.
- **Security headers:** served via a small `src/routes/api/__headers.ts` middleware plus static `<meta http-equiv>` for the ones that must land on document load. CSP will be `default-src 'self'; connect-src 'self' https://*.supabase.co; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'`.
- **NHS Number validation:** pure function `validateNhsNumber(s: string): boolean` (Mod 11, weights 10..2, checksum = 11 − (sum mod 11) with special-case 10 → invalid, 11 → 0). Unit-tested with the standard NHS test set.
- **FHIR export:** hand-rolled JSON matching FHIR UK Core `ServiceRequest` R4 profile — no library needed for a read endpoint; validated with the FHIR Validator locally during dev.
- **Retention job:** TanStack `api/public/cron/retention` route, HMAC-verified using existing `APP_HMAC_KEY`, scheduled via `pg_cron` calling the stable `project--{id}.lovable.app` URL.
- **Clinical safety reports table:** `clinical_safety_reports(id, reporter_id, referral_id, severity, description, status, created_at, resolved_at, resolved_by)` — RLS: reporter can read own + insert; admin can read/update all. GRANTs per template.
- **NHS Number & ODS migrations:** additive, nullable to start (backfill after), with a validation trigger that enforces Mod 11 when non-null.

## Open questions for you (I will ask again as we reach each phase)

1. Named **Clinical Safety Officer** (name, GMC/NMC/HCPC number, email) — required for Phase 3.
2. **Data Controller** legal name + **DPO** contact — required for Phase 2 privacy notice.
3. **ODS organisation code** for your trust — required for Phase 4.
4. Preferred **retention windows** (referrals, notes, audit log) — required for Phase 2 purge job.
5. Should the app enforce **passkeys as mandatory MFA** for clinicians (Phase 1.4), or allow TOTP as an alternative?
6. Any existing **DCB0129 clinical safety case** / **DPIA** documents to import, or start from templates?

---

## Suggested order of execution

I recommend I start with **Phase 1** (all technical, no external input needed) so the app hits the technical bar first; then pause for your answers to the Phase 2/3 questions above; then Phases 2 → 5 → 4 → 6 (accessibility before interoperability, because interop needs your ODS/vocabulary choices).

Reply **"proceed with Phase 1"** and I'll start executing, or tell me to re-order / drop items.
