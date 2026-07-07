## Point 8 — Coordinator-nurse ergonomics

Four small, high-impact ergonomics for the people running the unit at the wall-mounted screen, on the ward round, and at 3 a.m.

### 1. Whiteboard / TV mode (`/board`)

New route `src/routes/_authenticated/board.tsx` — full-screen, zero-chrome, high-contrast dark view designed for a wall-mounted TV.

Layout:
- Top bar: unit name, live clock, capacity strip (ICU 8/8 · HDU 4/6 · X pending referrals · Y post-op tomorrow).
- Two columns:
  - **Beds** — reuse `getBedBoard` data, group by ICU/HDU, big cells with hospital number/initials, level chip, day-of-stay, single-letter flags (V/N/H/P/R/T), isolation ring, predicted discharge date.
  - **Pending referrals** — `awaiting_review`, `awaiting_bed`, oldest first, with big timer for waiting time.
- Auto-refresh every 30 s via `useQuery` + `refetchInterval`. Falls back gracefully offline.
- No links, no navigation controls, `body.classList` adds a `.board-mode` class to hide the app chrome (route uses a minimal layout — renders directly in `__root` outlet but with `className="fixed inset-0 z-50 bg-black text-white"`).
- Escape key exits (`navigate(-1)`).

Not gated by admin — any signed-in staff member can open it.

### 2. Print-friendly ward round list (`/board/ward-round`)

Sibling route that renders the current bed board as a print-optimised table (one row per occupied bed): bed, patient, level, day, ventilated/inotrope flags, isolation, plan (predicted discharge + note), and a wide blank "Ward round jobs" column. Uses `@media print` styles so the app chrome disappears; auto-triggers `window.print()` when `?auto=1`.

### 3. Quick-filter chips on referrals list

Extend `referrals-rows.tsx`/index route with a row of one-click chips above the existing filter bar:
- **Awaiting review** — `outcome IS NULL AND status = 'pending'`
- **Awaiting bed** — `outcome = 'accept_admission' AND status != 'admitted'`
- **Accepted, not arrived** — `status = 'accepted' AND arrived_at IS NULL`
- **Discussed with consultant** — `discussed_with_consultant_at IS NOT NULL AND outcome IS NULL`
- **All**

Chips are pure client-side derived filters over the already-loaded referral list — they set a `quickFilter` search param and short-circuit the existing filter chain. Zero server changes.

### 4. Sound / vibration alert on new referral

New hook `src/hooks/use-new-referral-alert.ts`:
- Subscribes to the `referrals` realtime `INSERT` channel (already available via Supabase; enable in migration if not).
- Debounces to at most one alert per 3 s.
- Plays a short beep (WebAudio, generated at runtime — no asset file needed) and calls `navigator.vibrate([200,100,200])` when available.
- **Opt-in with obvious mute**: persisted in `localStorage` under `sdh-referral-alerts` (default OFF). Bell icon in the top bar toggles it and shows a red dot when armed.
- Autoplay policy: sound only fires after a user gesture; the toggle handler primes the AudioContext.

Mount the hook once at `src/routes/_authenticated/route.tsx` so it fires anywhere in the app.

### 5. Files

New:
- `src/routes/_authenticated/board.tsx`
- `src/routes/_authenticated/board.ward-round.tsx`
- `src/components/board/board-header.tsx`, `board-beds-column.tsx`, `board-referrals-column.tsx`
- `src/components/board/ward-round-table.tsx`
- `src/components/referrals/quick-filter-chips.tsx`
- `src/hooks/use-new-referral-alert.ts`
- `src/components/alert-toggle.tsx` (bell button)
- `src/lib/quick-filters.ts` + `quick-filters.test.ts`

Edits:
- `src/routes/_authenticated/route.tsx` — mount `useNewReferralAlert()` and put `<AlertToggle />` next to the notification bell.
- `src/routes/_authenticated/index.tsx` (referrals list) — render `QuickFilterChips`.
- `src/routes/_authenticated/bed-board.tsx` — add "Board mode" and "Ward round print" links in header.
- Migration: `ALTER PUBLICATION supabase_realtime ADD TABLE public.referrals` if not already added.

### 6. Tests

`quick-filters.test.ts` — filter predicates against a fixture list (each chip yields the correct subset).

### Out of scope

- Actual bleep/directory / on-call rota (Point 3/10).
- Sound file upload / voice selection.

### Size

~10 files, ~600 lines. No new tables, one publication ALTER, additive UI.

Implementation order: publication migration → quick filters (pure) + tests → alert hook + toggle → board + ward round routes → wire into referrals list and root layout.