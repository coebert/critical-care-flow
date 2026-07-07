
## Post-op booking operational glue (Point 4)

Turn `postop_bookings` from a data-capture form into a live scheduling workflow with lifecycle states, a planner, a cancellation register, and same-day conversion into a referral.

### 1. Booking lifecycle

Add a `booking_status` enum on `postop_bookings`:

- `requested` — new booking, awaiting review
- `provisionally_confirmed` — pencilled in, capacity permitting
- `confirmed` — bed guaranteed, anaesthetic sign-off complete
- `admitted` — patient has arrived on the unit (mirrors existing `arrived_at`)
- `cancelled` — cancelled with a required `cancellation_reason` enum:
  - `no_bed`, `patient_unfit`, `surgery_deferred`, `died_pre_op`, `other`
- Plus `cancellation_notes text`, `cancelled_at timestamptz`, `cancelled_by uuid`.

Also add `preop_signed_off_at` / `preop_signed_off_by` (anaesthetic sign-off) and `intensivist_reviewed_at` / `intensivist_reviewed_by` (consultant intensivist review). Both required before a booking can transition to `confirmed`.

Backfill: existing rows with `arrived_at` → `admitted`; otherwise `requested`.

Migration also indexes `(proposed_surgery_date, booking_status)` for planner queries.

### 2. Weekly / daily planner view

New route `postop-bookings.planner.tsx`:

- Week grid (Mon–Sun) — columns are days, rows are bookings ordered by predicted level (L3 first).
- Per-day header shows **committed beds vs remaining ICU/HDU capacity** using the same `capacity` helpers already used on the bed board.
- Cancelled/admitted rows are muted; requested/provisional/confirmed are the actionable ones.
- Day/week toggle; previous/next-week navigation.
- Click a card → existing edit page.

### 3. Cancellation-because-no-bed register

New route `postop-bookings.cancellations.tsx` (admin + coordinator):

- Table of every `cancelled` booking with reason, date, specialty, canceller.
- Filters by reason and date range; counter for `no_bed` (headline KPI).
- CSV export using existing CSV helpers.

### 4. Auto-conversion to referral

Server function `convertBookingToReferral({ id })`:

- Only allowed when `booking_status` in (`confirmed`, `provisionally_confirmed`) AND `proposed_surgery_date <= today`.
- Creates a referral pre-populated with hospital number, age/sex/weight, `reason_category = post_op`, `reason_notes = proposed_procedure`, `source = elective_admission`, and a `previous_referral_id` link back via a new `origin_booking_id` on referrals.
- Transitions the booking to `admitted` and stores the new `referral_id` on the booking row.
- Idempotent: if `referral_id` already exists, returns it.

Button appears on the edit page and on the planner card when conditions are met.

### 5. Server functions

Extend `src/lib/postop-bookings.functions.ts`:

- `updateBooking` accepts the new fields.
- New `transitionBookingStatus({ id, next_status, cancellation_reason?, cancellation_notes? })` — enforces valid transitions, requires sign-offs for `confirmed`, requires reason for `cancelled`.
- New `listBookingsInRange({ from, to })` for the planner.
- New `listCancellations({ from, to, reason? })` for the register.
- New `convertBookingToReferral`.

All under `requireSupabaseAuth`; admin-only for `listCancellations`.

### 6. UI pieces

- `src/components/postop/status-badge.tsx` — lifecycle chip with tone per status.
- `src/components/postop/status-transition-menu.tsx` — dropdown with the valid next-states and a cancel dialog capturing reason.
- `src/components/postop/planner-week-grid.tsx` — the week view.
- `src/components/postop/cancellation-table.tsx` — the register table.
- `src/components/postop/preop-signoff-panel.tsx` — anaesthetic + intensivist sign-off block on the edit page.
- List view (`postop-bookings.index.tsx`): new status column, filter chip row (`requested`, `provisional`, `confirmed`, `admitted`, `cancelled`), and a Planner / Cancellations link header.

### 7. Shared helpers

- `src/lib/postop-lifecycle.ts` — status enum, valid-transition matrix, `canTransition(current, next, ctx)`, cancellation reason labels, `isEligibleForConversion(booking)`.

### 8. Tests

- `postop-lifecycle.test.ts` — transition matrix (allowed / blocked / requires sign-off / requires reason).
- `postop-convert-to-referral.test.ts` — eligibility gating and idempotency.
- Extend existing authz tests to cover the new server fns.

### 9. Out of scope for Point 4

- Elective list integration from theatres PAS (Point 10).
- Consent workflow (Point 5).
- SMS/email to the referring team on cancellation (Point 6).

### Size

~1 migration, ~12–14 files, ~800–1000 lines. Additive columns, no breaking changes. All new columns nullable except the enum which defaults to `requested`.

Implementation order: migration → shared enums/utils → server-fn updates → planner route → cancellation register → conversion button → status badges/menus on list & edit → tests.
