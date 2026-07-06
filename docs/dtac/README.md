# DTAC evidence index — SDH Critical Care

This directory tracks evidence for the NHS Digital Technology Assessment
Criteria (DTAC v3) assessment. Each row lists a DTAC line item, the
artefact in this repository or product that satisfies it, and the status
of that artefact.

## Section C1 — Company information (organisational)

| Item | Artefact | Status |
| --- | --- | --- |
| Manufacturer legal name | Provided in DTAC response document | Owner to fill |
| Registered office / ICO number | Provided in DTAC response document | Owner to fill |

## Section C2 — Value proposition (organisational)

Owner completes in the DTAC response document.

## Section C3 — Clinical safety (DCB0129)

| Item | Artefact | Status |
| --- | --- | --- |
| Named Clinical Safety Officer | `docs/clinical-safety-case.md` (Phase 3) | Holding placard — `/clinical-safety` |
| Hazard log | `docs/hazard-log.md` (Phase 3) | Pending owner input |
| Clinical safety case | `docs/clinical-safety-case.md` (Phase 3) | Pending owner input |
| In-app safety-issue reporting | `/clinical-safety` route (Phase 3) | Holding placard live |
| Known-issues / field-safety notices page | Admin-editable page (Phase 3) | Pending |

## Section C4 — Data protection (UK GDPR / DPA 2018)

| Item | Artefact | Status |
| --- | --- | --- |
| DPIA | `docs/dpia.md` (Phase 2) | Pending owner input |
| ROPA | `docs/ropa.md` (Phase 2) | Pending owner input |
| Public privacy notice | `/privacy` route (Phase 2) | Complete |
| Cookie statement | `/cookies` route (Phase 2) | Pending |
| Data-subject rights (SAR / erasure) | `/profile` actions (Phase 2) | Pending |
| Data retention & purge | Retention cron job (Phase 2) | Pending |

## Section C5 — Technical assurance

| Item | Artefact | Status |
| --- | --- | --- |
| Secure development lifecycle | `docs/SECURE_DEVELOPMENT.md` | Complete |
| Vulnerability disclosure | `SECURITY.md`, `/security` route | Complete |
| Password policy (NCSC + HIBP) | `src/lib/password-policy.ts`, Supabase HIBP flag | Complete |
| Idle session timeout | `src/hooks/use-idle-timeout.ts` | Complete |
| Rate limiting on auth flows | `begin_auth_attempt` / `finalize_auth_attempt` RPCs | Complete |
| Encryption in transit | Provider-managed TLS 1.2+ | Complete |
| Encryption at rest — patient identifiers | `src/lib/crypto.server.ts` | Complete |
| Encryption at rest — clinical notes (E2E) | `src/lib/e2e-crypto.ts` | Complete |
| Role-based access control | `user_roles` table + `has_role()` | Complete |
| Audit trail | `audit_log` table | Complete |
| Backup & DR | Provider-managed PITR | Complete (evidence pending) |
| Cyber Essentials self-assessment | `docs/dtac/cyber-essentials.md` (Phase 6) | Pending |
| Penetration test | Scope doc under Phase 6 | Pending |
| SBOM | Generated via `bun x @cyclonedx/cyclonedx-npm` (Phase 6) | Pending |
| Push notification fanout test plan | `docs/dtac/push-notification-test-plan.md` | Complete |

## Section C6 — Interoperability

| Item | Artefact | Status |
| --- | --- | --- |
| NHS Number capture + Mod 11 validation | Phase 4 | Pending |
| ODS organisation code | `docs/ods-code.md` (Phase 4) | Holding placard |
| SNOMED CT for reason-for-referral / specialty | Phase 4 | Pending |
| FHIR R4 UK Core export | `/api/public/fhir/*` (Phase 4) | Pending |

## Section C7 — Usability & accessibility (WCAG 2.2 AA)

| Item | Artefact | Status |
| --- | --- | --- |
| Accessibility statement | `/accessibility` route (Phase 5) | Pending |
| Skip-link + landmarks | Phase 5 | Pending |
| Focus & keyboard audit | Phase 5 | Pending |
| Colour-contrast audit | Phase 5 | Pending |
| Automated axe scan in CI | Phase 5 | Pending |
| NHS Service Manual alignment | Phase 5 | Pending |

---

The overall implementation plan lives in `.lovable/plan.md`. When a phase
completes, update the corresponding rows here and reference the commit
or file that satisfies the criterion.
