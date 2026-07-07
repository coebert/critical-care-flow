## Referral workflow overhaul (Point 2)

Add the clinical fields senior ICU decision-makers actually rely on when triaging a referral, plus a proper outcome taxonomy and re-referral linking.

### 1. New clinical fields on `referrals`

Extend the table (all optional so existing rows stay valid):

- **NEWS2**: `news2_score int` (0–20) + `news2_recorded_at timestamptz`. Renders as a colour-coded badge on the list and detail. Small helper `computeNews2Tone(score)` for red/amber/green.
- **Ceiling of care**: `ceiling_of_care` enum — `full_escalation` | `no_cpr` | `ward_based` | `symptom_control` | `not_documented`. Required field once status leaves `pending`.
- **Structured reason for referral**: `reason_category` enum (~10 values: `respiratory_failure`, `sepsis`, `shock`, `post_op`, `neurology`, `trauma`, `gi_bleed`, `metabolic`, `overdose`, `other`), plus keep the existing free-text as `reason_notes`.
- **Frailty**: `frailty_score int` (Rockwell CFS 1–9), nullable — hidden unless age ≥ 65.
- **Anticipated interventions** (multi): `anticipated_interventions text[]` from a fixed vocabulary (`invasive_ventilation`, `niv_cpap`, `hfno`, `vasopressors`, `rrt`, `neuro_obs`, `arterial_line`, `central_line`, `other`).
- **Infection control**: `infection_status` enum — `none` | `suspected` | `confirmed` | `unknown`, and `infection_organism text` (free text, capped).
- **First-class safety fields**: `weight_kg numeric(5,1)`, `allergies text`, `resus_status` enum — `for_cpr` | `dnacpr` | `not_documented`.
- **Re-referral linking**: `previous_referral_id uuid references public.referrals(id)`. Nullable. On the "new referral" form, if the hospital number matches a recent referral, offer to link.

Migration wraps `ALTER TABLE` + enum creation + backfill defaults + preserve RLS/GRANTs (no policy changes needed — additive columns only). Existing encrypted-field pipeline untouched.

### 2. Outcome taxonomy — three distinct decisions

Today `status` conflates decision + workflow state. Add `outcome` enum captured at the point of decision:

- `admit_for_admission` — accept & admit (current "accepted"/"admitted" path)
- `review_on_ward` — "come and review", no bed yet
- `advice_given` — telephone advice only, referral closes
- `declined` — as today

`status` stays as the workflow lifecycle (`pending` → `seen` → `decision` → `closed`). The two are related but no longer collapsed. The referral detail form gates required fields per outcome (e.g. advice-given requires `discussed_with_consultant` and `reason_notes`; review_on_ward requires `first_seen_at`).

Migration adds `outcome` enum + `outcome_recorded_at`. Old rows are backfilled from `status` (`admitted`/`accepted` → `admit_for_admission`, `declined` → `declined`, everything else → NULL).

### 3. UI changes

- **`referrals.new.tsx`**: new sections — Clinical (NEWS2, weight, allergies, infection), Decision-making (ceiling of care, resus, frailty when ≥65), Anticipated interventions (checkbox grid), Reason (category + notes). Re-referral banner when HN matches an existing open/recent referral, with "Link to previous referral" button.
- **`referrals.$id.tsx`**: same field groups; outcome selector replaces the current status dropdown for decision. Save-time validation gates per outcome. Show linked previous-referral chip at the top.
- **List view** (`_authenticated/index.tsx`): NEWS2 badge, ceiling-of-care chip, and outcome pill on each row. New filter chips: outcome, ceiling, infection.
- **Prior-declined component**: extended to `PriorReferralsPanel` — shows any linked prior referral chain, not just declines.

### 4. Reusable pieces

- `src/lib/referral-clinical.ts` — enums, labels, `computeNews2Tone`, `getAnticipatedInterventionLabels`.
- `src/lib/referral-outcome.ts` — outcome enum, validation rules per outcome, `deriveOutcomeFromLegacyStatus` for the backfill mirror on read.
- `src/components/referrals/clinical-fields.tsx` — grouped inputs (used by both new + edit forms).
- `src/components/referrals/outcome-selector.tsx` — the three-way outcome picker with contextual required-field hints.
- `src/components/referrals/reference-referral-picker.tsx` — HN-match lookup with recent-referral list.

### 5. Server functions

Extend `src/lib/referrals.functions.ts`:

- `createReferral` / `updateReferral`: accept the new fields, validate outcome→required fields, persist `previous_referral_id` link.
- New `findRecentReferralsByHospitalNumber({ hospital_number })` — returns last 5 non-deleted referrals matching HN, used by the new-referral form for the "link to prior" prompt.

All new fields go through the existing zod schema layer; no encryption changes because none of the new fields are free-text patient identifiers (reason_notes stays encrypted like existing note fields, infection_organism is short + non-identifying).

### 6. Tests

- Unit: `referral-outcome.test.ts` — outcome→required-field matrix.
- Unit: `referral-clinical.test.ts` — NEWS2 tone thresholds, frailty visibility (age≥65).
- Unit: `find-recent-referrals.test.ts` — HN normalisation + limit.

### 7. Out of scope for Point 2 (belongs to later points)

- SBAR handover generator (Point 3)
- Sepsis-6 / clinical decision-support checklists (Point 7)
- Datix and outcome/mortality capture (Point 5)

### Estimated size

~1 migration, ~10–12 files changed/created, ~700–900 lines total. No breaking changes; all new columns are nullable.

---

**Please confirm** and I will implement in this order: migration → shared enums/utils → server-fn updates → new-referral form → detail form → list view → tests.
