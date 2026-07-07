# Bed state & capacity — implementation plan

This adds a first-class concept of the unit itself: which beds exist, who occupies them, predicted discharges, ward-based level-2 outliers, and outbound transfers/retrievals. It plugs into the existing referrals + post-op booking flows so a coordinator has one place to see "can we accept?".

## Scope (this phase)

1. **Bed register** — the fixed list of ICU/HDU/side-room beds on the unit.
2. **Bed occupancy** — who is currently in each bed, with clinically-relevant flags.
3. **Predicted discharges / step-downs** — a per-occupant field feeding a *net available beds in 24 h* number.
4. **Outlier register** — patients receiving level-2 care outside the unit.
5. **Transfers out / retrievals** — repat + tertiary transfer tracking.
6. **Capacity snapshot** — a compact strip shown at the top of Referrals and on a new `/bed-board` route.
7. **Bed board page** — the coordinator's whiteboard view (also usable in a wall-mounted TV mode later).

Out of scope for this phase (called out so it's not forgotten): ward-round list export, NEWS2 trends, mortality/outcome capture, ceiling-of-care fields on referral, SBAR handover generator — those live in points 2, 3, 5 of the review.

## Data model

New tables (all in `public`, RLS on, GRANTs to `authenticated` + `service_role`, no `anon`):

- **`beds`** — the static register.
  - `code` (e.g. "ICU-1", "HDU-3"), `unit` enum (`icu` | `hdu`), `is_side_room` bool, `notes`, `active` bool, `sort_order` int.
  - Seeded via migration with SDH's actual bed list (placeholder count now, editable by admin).
- **`bed_occupancies`** — one row per admission-to-bed, soft-closed on discharge.
  - `bed_id`, `hospital_number`, `patient_initials`, `admitting_consultant`, `admitted_at`, `discharged_at` (null = current), `level` (`1|2|3`), flags: `ventilated`, `nippv_cpap`, `hfno`, `vasopressors`, `renal_replacement`, `tracheostomy`, `isolation` enum (`none|contact|droplet|airborne`), `isolation_reason`, `requires_side_room`, `predicted_discharge_at` (nullable timestamptz), `predicted_step_down` enum (`ward|hdu|home|other|null`), `notes`.
  - Partial unique index on `(bed_id) WHERE discharged_at IS NULL` so a bed can't have two live occupants.
  - Optional FK `source_referral_id` and `source_postop_booking_id` (both nullable) to link admission back to its origin.
- **`bed_outliers`** — level-2 patients on the ward.
  - `hospital_number`, `patient_initials`, `ward`, `admitting_consultant`, `started_at`, `ended_at`, `level` (2 only for now), flags mirror occupancies (organ-support fields), `reason`, `notes`.
- **`bed_transfers_out`** — repats + tertiary transfers.
  - `occupancy_id` (FK), `kind` enum (`repat|tertiary|other`), `destination_hospital`, `destination_specialty`, `reason`, `transport_mode` enum (`land_ambulance|air|self|other`), `requested_at`, `accepted_at`, `eta_at`, `departed_at`, `status` enum (`requested|accepted|awaiting_transport|in_transit|completed|cancelled`), `notes`.

Standard `id`, `created_at`, `updated_at`, `created_by`, `updated_by`. `set_updated_at` trigger on all four.

## RLS

Clinical data — same posture as `referrals`:
- SELECT: `has_clinical_access(auth.uid())`.
- INSERT/UPDATE: `has_clinical_access(auth.uid())`, `created_by = auth.uid()` on insert.
- DELETE: admin only (soft delete via `deleted_at`/`deleted_by` on `bed_outliers` and `bed_transfers_out`; occupancies are closed with `discharged_at`, not deleted, to preserve the audit trail).
- `beds`: SELECT for any clinical user; INSERT/UPDATE/DELETE admin only.

## Server functions

New `src/lib/beds.functions.ts`:
- `listBeds()` — all active beds, sorted.
- `getBedBoard()` — beds + current occupancy + outliers + open transfers in one call (used by page + capacity strip).
- `admitToBed({ bed_id, ...occupancyFields })` — creates an occupancy; optional `source_referral_id` / `source_postop_booking_id`.
- `updateOccupancy({ id, patch })` — vitals/flags/notes/predicted-discharge edits.
- `dischargeOccupancy({ id, discharged_at, step_down, actual_destination })`.
- `moveOccupancy({ id, new_bed_id })` — closes old, opens new, chained in a single RPC for atomicity.
- `createOutlier / updateOutlier / endOutlier`.
- `createTransferOut / updateTransferOut / cancelTransferOut`.

All `.middleware([requireSupabaseAuth])` and validate with a small zod schema per fn (mirrors `referrals.functions.ts`).

Admin-only bed register CRUD lives in `src/lib/admin.functions.ts` alongside the existing admin fns.

## Derived capacity numbers

Computed in a shared util `src/lib/bed-capacity.ts` (pure, unit-tested):
- `beds_by_unit` — total active, per ICU/HDU.
- `occupied` / `free` per unit.
- `predicted_free_in_24h` = `free + occupancies where predicted_discharge_at <= now + 24h`.
- `pending_referrals` — count from existing referrals list (accepted-not-arrived + awaiting-decision).
- `pending_postop_tomorrow` — count from `postop_bookings` where `proposed_surgery_date` is today/tomorrow and status not cancelled.
- `outliers_count`, `open_transfers_count`.

## UI

New route `src/routes/_authenticated/bed-board.tsx`:
- Top strip: capacity snapshot (same component used on referrals).
- Grid of bed cards grouped by unit, sorted by `sort_order`. Each card shows occupant initials + hospital number, admitting consultant, day-of-stay, level pill, organ-support icons (vent/RRT/inotrope/HFNO/NIV/trache), isolation badge, predicted discharge chip.
- Empty beds show a subtle "+" to open the "Admit to bed" dialog (pre-fills from a referral or booking if opened from those pages).
- Side panels (collapsible): "Outliers (n)" and "Transfers out (n)" with inline add/edit.
- Realtime: single Supabase channel on `bed_occupancies`, `bed_outliers`, `bed_transfers_out` invalidates the `getBedBoard` query.

New component `src/components/bed-board/capacity-strip.tsx` reused on:
- `/bed-board` (top of the page).
- `/` referrals list (above the filters, collapsible on mobile).

New components co-located under `src/components/bed-board/`:
- `bed-card.tsx`, `bed-grid.tsx`, `admit-dialog.tsx`, `edit-occupancy-dialog.tsx`, `discharge-dialog.tsx`, `move-bed-dialog.tsx`, `outlier-panel.tsx`, `outlier-dialog.tsx`, `transfers-panel.tsx`, `transfer-dialog.tsx`.

## Wiring into existing flows

- **Referrals list**: capacity strip at the top; on an accepted referral row, a new "Admit to bed" action opens the dialog pre-filled from the referral.
- **Referral detail (`referrals.$id.tsx`)**: same "Admit to bed" action in the action row; once admitted, shows the linked bed + link back to the bed board.
- **Post-op booking detail/edit**: same admit action; converts a confirmed booking into a live occupancy.
- **Sidebar**: add "Bed board" under a new "Work" group heading (matches the existing plan's grouping suggestion).

## Migrations

Single migration file with all four tables in order (`beds`, `bed_occupancies`, `bed_outliers`, `bed_transfers_out`), each followed by its GRANTs → `ALTER TABLE … ENABLE RLS` → policies, then `set_updated_at` triggers, then a seed `INSERT` for a starter set of beds (10 ICU + 6 HDU, editable in admin). No CHECK on time-dependent expressions — the `bed_occupancies` "one live per bed" rule is enforced by the partial unique index, not a CHECK.

## Tests

Unit tests for `bed-capacity.ts` (edge cases: no beds, all beds occupied, predicted discharges in the past, mixed units). Authz tests mirroring the existing `postop-*-authz.test.ts` pattern for `admitToBed`, `dischargeOccupancy`, `moveOccupancy`, and outlier/transfer CRUD.

## Rollout order (as I build it)

1. Migration (tables, RLS, seed, triggers).
2. `bed-capacity.ts` + unit tests.
3. `beds.functions.ts` + authz tests.
4. `/bed-board` route with grid, admit/edit/discharge/move dialogs.
5. Outliers + transfers side panels.
6. Capacity strip on Referrals list.
7. "Admit to bed" wiring from referral detail and post-op booking detail.
8. Sidebar entry + minor nav grouping tweak.

Estimated ~600 lines of new SQL/TS across ~15 files. No breaking changes to existing tables or routes.
