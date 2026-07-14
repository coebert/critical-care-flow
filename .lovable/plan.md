
# Ergonomics & Usability Review — Critical Care Flow

Findings from a design-team review of the authenticated app (bed board, referrals, inbox, post-op, analytics, admin). Organised by impact, then a phased action plan.

## What's working well
- Consistent semantic token system (`--primary`, `--muted`, etc.) with a coherent clinical teal/slate identity and full dark mode.
- shadcn + Radix primitives → ARIA and keyboard behaviour largely correct out of the box.
- Strong domain features already shipped: acuity badges, isolation, wardable, scan-transfer, end-of-life, violence risk, capacity strip, RLS regression tests.

## Highest-impact friction points

### 1. Cognitive load on the bed board
- BedCard packs 8–10 signals (level, initials, hospital #, consultant, day of stay, organ support icons, isolation, wardable, EOL, violence, scan, D/C ETA) with no visual hierarchy. Icons and badges compete for the same row.
- Icon-only badges rely on hover tooltips — unusable on touch and on the current 440px mobile viewport.
- 2102-line `bed-board.tsx` mixes route, dialogs, capacity, legend, filters — hard to iterate on safely.

### 2. Mobile ergonomics
- User is on a 440×673 viewport. Grid is `grid-cols-2` at that width → each card ~200px wide, badges wrap onto 3 rows and truncate patient name.
- Filter/legend rows in referrals use `flex-wrap` with many chips → tall header eats half the viewport before any data.
- Some tap targets (icon badges, sort chevrons, chip toggles) fall below 44×44.

### 3. Navigation & wayfinding
- 22 authenticated routes, no grouping in the sidebar (bed board / clinical / analytics / admin all flat).
- No global search or command palette — every jump requires sidebar → filter → scroll.
- No breadcrumbs on nested routes (`referrals/$id`, `postop-bookings/$id/edit`), and no "back to list" affordance.

### 4. Referrals workflow
- Filter surface (5 chip rows + 2 search inputs) always expanded — dominates the page and pushes the list below the fold.
- Status is a chip row; date, urgency, location, age group all repeat the same pattern → visually noisy, no saved views.
- New/edit referral form is a single long scroll (580 lines) without step grouping or a sticky action bar; primary action can fall off-screen mid-edit.

### 5. Feedback & state
- Loading states rely on Suspense fallbacks that flash empty regions rather than skeletons matching the grid.
- Toasts are the only confirmation channel for many mutations (admit, discharge, task complete) — no undo, no inline echo on the affected row.
- Realtime updates land silently; a row can change under the user's cursor with no highlight.

### 6. Accessibility gaps (spot check)
- Icon-only Buttons in a few places (`size="icon"` without `aria-label`) — e.g. sort/collapse toggles.
- Colour is sometimes the only channel for acuity level and urgency (L0/L1/L2/L3 tone-only badges).
- Placeholder greys on some inputs are close to `text-muted-foreground/50` — borderline WCAG AA on light bg.
- Hydration mismatch on `/auth` (see runtime errors) — silent SSR bug worth clearing.

### 7. Density & typography
- 12 different font sizes in bed-board alone (`text-[10px]` through `text-2xl`). Reads noisy.
- Card padding (`p-3`) is uniform regardless of density mode — no "comfortable/compact" toggle for users on ward TVs vs phones.

## Phased action plan

### Phase 1 — Quick wins (½–1 day each, no schema changes)
1. **Split `bed-board.tsx`** into `bed-board/{page,legend,filters,capacity-header}.tsx` (route stays thin). Enables all later work.
2. **Fix hydration mismatch on `/auth`** (Suspense→div swap in SSR output).
3. **Sticky action bars** on `referrals.new`, `referrals.$id`, `postop-bookings.$id.edit` — primary save always in reach.
4. **Skeleton loaders** matching bed grid and referrals table shape.
5. **`aria-label` sweep** for every `size="icon"` Button; add non-colour indicator (letter L0–L3 already present — reinforce with weight/border).
6. **Density toggle** on the bed board (comfortable/compact) persisted per user in localStorage.

### Phase 2 — Bed board rework (2–3 days)
1. **Card hierarchy**: patient name + bed code = primary row; acuity chip right-aligned; secondary meta (consultant, day) muted 12px; badges collapse into a single wrap row with a fixed left-to-right order (Isolation → EOL → Violence → Scan → Wardable → OrganSupport).
2. **Tap-friendly badges**: min 32×32 hit area, long-press on mobile reveals label popover (Radix Popover already available), tooltip only on desktop hover.
3. **Collapsible left rail** for unit selector + capacity summary; bed grid gets full width on tablet.
4. **Row highlight animation** (1.5s outline pulse) on realtime updates so silent changes are noticed.
5. **Legend**: move from bed-board into a shared `<InfoPopover>` triggered from the header — one legend, reused on TV board.

### Phase 3 — Referrals & workflow (2–3 days)
1. **Collapse filter surface into a single toolbar**: search + "Filters (n)" button opening a Sheet on mobile / Popover on desktop. Show active filter chips as removable pills below.
2. **Saved views** (My open, Handover, Overdue tasks) — stored per user; default landing view configurable.
3. **Two-column form layout** on `referrals.new` at ≥`md`, section anchors on the left, sticky "Save draft / Submit" footer.
4. **Inline row echo** for mutations (accept/decline/complete task) with 5s undo toast.

### Phase 4 — Navigation & findability (1–2 days)
1. **Sidebar grouping**: Clinical (Bed board, Referrals, Inbox, Ward round) · Planning (Post-op) · Insight (Analytics) · Admin.
2. **Command palette** (`⌘K`) — routes, patients (by initials/hospital #), open referrals, common actions (Admit bed, New referral).
3. **Breadcrumbs** on all detail routes with "back to list" preserving filters.
4. **Global banner slot** for shift handover / capacity red alerts (already have data, no surface).

### Phase 5 — Polish & accessibility (1 day)
1. Reduce type scale in bed-board to 4 sizes (11/13/14/16 px equivalents).
2. WCAG AA audit pass on placeholder text, level badges, and urgency chips; add shape or letter as a second channel.
3. Motion: honour `prefers-reduced-motion` for row pulses and skeleton shimmer.
4. Empty states: every list gets an illustration + primary CTA instead of "No results".

## Suggested sequencing
Phase 1 first (unblocks everything, immediately visible on mobile). Then Phase 2 in parallel with Phase 3 (different files, low conflict risk). Phase 4 lands last so grouping reflects the reworked surfaces.

## Technical notes
- All work stays in `src/routes/_authenticated/**`, `src/components/bed-board/**`, `src/components/referrals/**`, and the sidebar in `src/routes/_authenticated/route.tsx`. No DB migrations, no RLS changes.
- Density toggle, saved views, and sidebar collapse state persist in `localStorage`; read inside `useEffect` to avoid SSR mismatch.
- Command palette: use `cmdk` (already a shadcn dep via `Command`).
- Row-pulse: CSS `@keyframes` gated behind `motion-safe:`.

Want me to start with Phase 1 (splits `bed-board.tsx`, fixes hydration, adds skeletons and density toggle), or pick specific items across phases?
