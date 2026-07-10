## Goal

Populate the bed board's occupancy cells directly from the partner ICU Handover Hub's `/api/public/bridge/beds` payload, instead of pulling per-table `bed_occupancies` (which the partner doesn't expose).

## What the partner actually returns

`GET https://icu-compass-care.lovable.app/api/public/bridge/beds` returns:

```text
{
  unit, side_rooms: [labels],
  bed_board: [{ bed, is_side_room, occupied, occupant: {
    id, full_name, hospital_number, age, status, bed,
    admission_date, tep_in_place, dnacpr_decision,
    outstanding_tasks, updated_at
  } | null }],
  unassigned: [occupants],
  stats: { total_beds, occupied, available, unassigned }
}
```

There is **no** clinical acuity (level, ventilated, HFNO, vasopressors, isolation, side-room requirement, predicted step-down/discharge). There are no outliers and no transfers.

## Approach

1. **New server function `getPartnerBedBoard`** (`src/lib/beds.functions.ts`):
   - Calls the partner endpoint server-side with the existing HMAC scheme (`HANDOVER_API_SECRET`, `x-timestamp`, `x-actor`, `x-signature`), acting as a `system` actor.
   - Returns the parsed payload plus a `fetchedAt` timestamp.
   - Falls back to `{ error }` on partner failure so the UI can surface it.

2. **Adapter** turning the payload into the shape existing components already accept, so we don't rewrite `BedGrid`/`CapacityStrip`:
   - Map each partner `bed_board[i]` into a synthesized `Bed` (id = `partner:${label}`, code = label, is_side_room, unit inferred, active true, sort_order = index) and a synthesized `Occupancy` when occupied (id = occupant.id, bed_id matches, patient_initials from initials of `full_name`, hospital_number, admitted_at = admission_date, level = null, all acuity fields null/false).
   - `outliers` and `transfers` become empty arrays (partner doesn't expose them).

3. **Rewire `src/routes/_authenticated/bed-board.tsx`**:
   - Swap `useServerFn(getBedBoard)` → `useServerFn(getPartnerBedBoard)`.
   - Pass adapted data into `BedGrid` unchanged.
   - Hide the local-write UI paths that can't round-trip to partner: Admit / Edit / Discharge / Move dialogs, Outliers panel, Transfers panel, Nurse Capacity panel (all depend on acuity or on writing to local tables the partner doesn't own). Replace with a read-only occupant popover on click showing `full_name`, `hospital_number`, `age`, `admission_date`, `tep_in_place`, `dnacpr_decision`, `outstanding_tasks`, `updated_at`.
   - Drop the Realtime subscription (partner tables aren't in our DB); keep the 20s polling refetch and refetch-on-focus.
   - Show `unassigned` occupants in a small list under the grid.
   - Replace `CapacityStrip` with a simplified strip driven by partner `stats` (total/occupied/available/unassigned), since we can't compute acuity-based capacity.

4. **Capacity callouts elsewhere** (`getCapacitySnapshot`, `admission-capacity-callout`, `capacity-badge`) keep reading local tables for now — out of scope. A short note in the file header explains they'll return zeroed capacity until the partner exposes acuity data.

5. **Leave writes and sync alone**: `admitToBed`, `updateOccupancy`, etc. remain exported (still used by referrals/postop flows) but the bed board no longer surfaces them. The pg_cron bridge sync for `bed_occupancies` / `bed_outliers` / `bed_transfers_out` stays; when the partner adds those endpoints later, that sync populates local tables and we can revert the UI.

## Technical details

- Partner fetch uses `node:crypto` `createHmac` with `HANDOVER_API_SECRET` (already configured). Timestamp is unix seconds, actor JSON is `{"id":"bridge-consumer","role":"system"}`, body is `""` for GET.
- `PARTNER_BRIDGE_URL` is already configured — use it as the base URL and append `/beds`.
- Response cached for 5s in the server fn to avoid hammering the partner from concurrent tabs.
- Add `Cache-Control: no-store` to the fetch to bypass any CDN caching.
- Synthesized bed IDs are strings prefixed `partner:` so downstream code that expects UUIDs doesn't accidentally query the local DB with them (BedGrid only uses id/code for keys).
- Types: introduce a `PartnerBedBoard` type in `src/lib/beds.functions.ts` and adapt inside the component via a small `useMemo`.

## Out of scope

- Restoring acuity, outliers, transfers, nurse-capacity, and admit/discharge flows on the bed board. These need the partner to expose the missing tables (see `docs/partner-bridge-handoff.md`), then a revert of the read-only mode.
- Changing how referrals and postop-bookings surface admission capacity. Those keep the local-DB path.
