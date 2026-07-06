
# SDH Critical Care — design, styling & ergonomics review

I stepped through the app as a mixed persona — an on-call registrar on a phone in the ED, a consultant at a desk reviewing analytics, and a new user hitting the sign-in card cold. Below is what's working, what isn't, and a phased plan to fix it without redesigning the product.

## Overall verdict

The visual language is on-brief: a calm clinical teal/slate palette, sensible shadcn primitives, `oklch` tokens, no gaudy gradients. Nothing in the UI shouts, which is right for a patient-safety tool. The problems are almost entirely **execution-level**: broken typography on statutory pages, an auth screen that floats in the middle of a huge blank canvas, an authenticated shell that has grown organically and now feels dense and noisy on mobile, and several routes that are still 500–800-line monoliths.

## What's working

- Sensible information architecture — Referrals / New / Post-op / Inbox / Notifications / Profile / Admin — no dead nav.
- Genuine clinical-grade thinking: idle timeout, E2E encryption banner, push-permission prompt, shift toggle, per-recipient key badges. These are rare and correct.
- Design tokens are all semantic (`--primary`, `--success`, `--warning`, `--destructive`, chart colors) with a proper dark theme. No hard-coded `#fff`/`bg-black` in the components I sampled.
- Sidebar collapse state is persisted; mobile drawer closes on route change; route-active styling uses `exact` matching — small ergonomic wins.

## What isn't working

### 1. Statutory pages are literally unstyled

`/clinical-safety`, `/privacy`, `/security` render as a flat wall of text: no heading sizes, no list bullets, no paragraph rhythm, no link underlines. Cause: they use `prose prose-slate` from `@tailwindcss/typography`, but Tailwind v4 needs the plugin registered explicitly in `src/styles.css` and it isn't. Every `prose-*` utility is silently no-op. This is the single most visible defect in the app and it directly affects DTAC/DCB0129 credibility — these are the pages a Trust IG lead will read first.

### 2. Auth screen composition

The sign-in card is centered horizontally but sits **~⅔ of the way down** the viewport on desktop with a huge empty top half. Cause: a wrapper without full-height centering. It should either (a) be genuinely vertically centered on tall viewports, or (b) sit under a compact hero band with the product name, a one-line pitch, and links to Clinical safety / Privacy / Security — those links are legal/DTAC requirements and are currently invisible on the sign-in view.

### 3. Authenticated top bar is crowded on mobile

The 56px header stacks: hamburger + collapse toggle + ShiftToggle + TestPushButton + NotificationBell — with `flex-wrap` at 375–440px this can wrap to two lines and steals vertical space above the fold. There's also no page title/breadcrumb, so on a phone the user often can't tell which screen they're on until content paints. The mobile ergonomics fix is a fixed-height header with icon-only widgets, an app-title slot that mirrors the current route, and no wrap.

### 4. Navigation is a flat list of 8 items

The sidebar mixes primary workflow (Referrals, New, Post-op, Inbox) with settings-ish items (Notifications, Push test, Profile, Admin). "Push test" in particular is a developer utility surfaced as a first-class nav item. Grouping: **Work** (Referrals, New referral, Post-op bookings, Inbox) / **Alerts** (Notifications, with Push test tucked into Profile or Admin) / **You** (Profile) / **Admin** (Analytics, Admin) improves scan time and stops Push test from looking like a clinical feature.

### 5. Route files still too large

Despite recent extraction work, several routes remain monoliths that will keep accreting logic:

| Route | LOC |
|---|---|
| `_authenticated/index.tsx` (Referrals list — the home screen) | 801 |
| `_authenticated/referrals.new.tsx` | 702 |
| `_authenticated/referrals.$id.tsx` | 574 |
| `_authenticated/profile.tsx` | 529 |
| `_authenticated/inbox.tsx` | 465 |
| `components/postop-analytics-panel.tsx` | 453 |
| `components/noteboard.tsx` | 420 |

Each hides sub-concerns (filters, sort, pagination, action bars, empty states) that deserve their own presentational components — mirrors the analytics/noteboard refactor already done.

### 6. Density & rhythm

Cards use `p-5`, list rows use ad-hoc paddings, chip rows use `p-2`, header uses `h-14` — the vertical scale isn't quantised. Result: on a busy Referrals list the eye has to keep re-anchoring. A single spacing scale (`--space-1..8` mapped to 4-px increments, and a shared `SectionCard` / `ListRow` primitive) would tighten every screen at once.

### 7. Colour semantics under-used

`--success` / `--warning` / `--destructive` exist but the codebase mostly reaches for raw `emerald-500/10`, `amber-*`, `sky-*` (visible in `note-recipient-chip-row.tsx`, `note-partial-coverage-alert.tsx`). This works but breaks the design-system contract — dark-mode contrast for those raw palettes wasn't tuned, and future theming can't move them. All chip/alert tones should go through tokens.

### 8. Accessibility gaps

- `min-h-screen` used in several roots — should be `min-h-dvh` for iOS mobile Safari (the address bar eats the last strip otherwise).
- Icon-only buttons in `NoteRecipientChipRow` have `title=` (hover only) but no `aria-label`; on mobile they're unlabeled to a screen reader.
- The auth card has `autoFocus`-like flow on the email input which is fine, but the "Keep me signed in" helper text sits under the checkbox without a `label`-linked association.
- 404 and error pages have solid, tap-friendly buttons but the error page uses `<a href="/">` instead of `<Link>` — full reload, loses router context.

### 9. Runtime hydration warning

`/auth` throws a React hydration mismatch on load (route `_authenticated` renders a `<Suspense>` on the server and a `<div>` on the client). It doesn't break the page but it's a real SSR bug that will surface with every future SSR-adjacent change. Fix at the same time as the auth-layout rework.

### 10. Meta / share-preview polish

`__root.tsx` sets an `og:image` pointing at a Lovable-hosted preview screenshot. That's on `__root`, so per the head-metadata rule it overrides every leaf route's own og image and shows a stale screenshot of the app in every share card. Move to leaf routes (or drop it and let the platform inject).

---

## Improvement plan (phased, non-breaking)

Each phase is independently shippable — no phase requires the next.

### Phase 1 — quick correctness wins (½ day)
1. **Register Tailwind Typography** in `src/styles.css` (`@plugin "@tailwindcss/typography"` + `bun add -d @tailwindcss/typography`) so `/clinical-safety`, `/privacy`, `/security` render with proper heading scale, list bullets, link underlines, blockquote rhythm.
2. **Fix auth-page composition**: full-viewport flex-center on `dvh`, add a compact hero header ("SDH Critical Care · Referral tracker") and footer row linking Clinical safety / Privacy / Security disclosure.
3. **Fix root SSR/CSR mismatch** on `/auth` (the error listed in runtime-errors).
4. **Replace `min-h-screen` with `min-h-dvh`** in root shell, auth page, 404, error page.
5. **Move `og:image` off `__root`** — either remove or push to leaf routes with route-appropriate images.

### Phase 2 — chrome & density (1 day)
6. **Header rework**: fix 48-px header height, icon-only ShiftToggle/TestPush/NotificationBell on `<sm`, page-title slot bound to the active route (read from `useRouterState`), no `flex-wrap`, grid-based responsive layout (`grid-cols-[auto_1fr_auto]`).
7. **Sidebar grouping**: cluster nav into labelled sections (Work / Alerts / You / Admin) with a muted section heading; move "Push test" under Profile or Admin. Preserve `activeOptions={{exact:true}}` behaviour.
8. **Establish shared primitives** in `src/components/ui/` extras: `PageHeader`, `SectionCard`, `ListRow`, `EmptyState`, `Toolbar`. Migrate one screen (Referrals index) as reference.
9. **Quantise spacing**: add `--space-*` tokens; retire ad-hoc `p-5`/`p-2` where the new primitives supply padding.

### Phase 3 — colour & a11y hygiene (½ day)
10. **Token migration** for status colours: introduce `--info` (sky-tinted) and reuse `--success`/`--warning`/`--destructive` throughout `note-recipient-chip-row`, `note-partial-coverage-alert`, admission-urgency badges. Verify dark-mode contrast (WCAG AA ≥ 4.5:1 on body text, ≥ 3:1 on chip text).
11. **A11y sweep**: `aria-label` on every icon-only control; associate helper text with its input via `aria-describedby`; replace `<a>` with `<Link>` in the error page; audit tap targets ≥ 44 px on `<sm`.

### Phase 4 — code composition (1–2 days)
12. **Split the big routes** using the analytics/noteboard playbook — extract into small, presentational subcomponents co-located under `src/components/<feature>/`:
    - `index.tsx` (Referrals list) → `ReferralsToolbar`, `ReferralsFilters`, `ReferralsTable`, `ReferralsEmptyState`, `useReferralsQuery`, `useReferralsFilters` (URL-synced).
    - `referrals.new.tsx` → `ReferralPatientBlock`, `ReferralClinicalBlock`, `ReferralAdmissionBlock`, `ReferralComposerActions`, and a `useReferralForm` hook wrapping the zod schema + submit.
    - `referrals.$id.tsx` → `ReferralHeader`, `ReferralTimeline`, `ReferralActions`, `ReferralAuditTrailPanel`.
    - `profile.tsx` → `ProfileIdentitySection`, `ProfileSecuritySection`, `ProfilePasskeysSection`, `ProfilePushPreferencesSection`.
    - `inbox.tsx` → `InboxFilters`, `InboxList`, `InboxRow`, `InboxPagination`.
    - `postop-analytics-panel.tsx` → per-metric card + a `usePostopAnalytics` query hook.
13. **Add a route-level `PageHeader`** in each so titles, breadcrumb, and page actions live in one place instead of being reinvented per route.

### Phase 5 — polish (optional, ½ day)
14. **Loading & empty states**: replace bare "Loading…" text with skeletons matching the target layout; craft one-line empty states with a suggested next action per screen.
15. **Motion pass**: gentle `data-[state]` transitions on the sidebar collapse, alert dismissals, and modal open — no bounces, no gradients. Prefer `transition-[colors,transform] duration-150` on interactive elements only.
16. **Copy pass**: audit button labels ("Post encrypted note" / "Unlock & post" already great; opportunities in referral form and profile page for verbs-with-object).

---

## Technical notes

- **Tailwind v4 plugin registration**: v4 uses `@plugin "..."` in CSS, not `plugins: []` in a JS config. Verified against `styles.css` (no `tailwind.config.js` exists — this is a v4 project).
- **`min-h-dvh` support**: safe in every browser this app targets (NHS-approved browser matrix is Edge/Chrome/Firefox current + Safari 16.4+). Fallback: `min-h-screen min-h-dvh` cascade.
- **Refactor safety**: every route split is behaviour-preserving. Recommend one PR per screen, each with a `tsgo` + Playwright smoke.
- **No product changes**: nothing in this plan alters clinical workflows, data model, RLS, or server functions. It's presentation-layer only, matching the ongoing refactor cadence.

## Recommended order

If you want a single sequence: **Phase 1 → Phase 3 (a11y bits only) → Phase 2 → Phase 4 → Phase 5**. That fixes the two visible embarrassments (unstyled statutory pages, floating auth card) first, gets accessibility to compliance level second, then rebuilds the chrome, then reorganises the routes on the new primitives.

Say the word and I'll start with Phase 1.
