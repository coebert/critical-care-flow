
# Salisbury Critical Care Referral Tracker

A secure, internal web app for the Salisbury District Hospital critical care team to log, track, and audit patient referrals in line with ICNARC data requirements.

## Backend (Lovable Cloud)

Enable Lovable Cloud for authentication, encrypted Postgres, and row-level security. All traffic over HTTPS; database encrypted at rest.

### Auth model — admin-invite only
- Email/password sign-in (no public sign-up).
- A `user_roles` table with roles: `admin`, `clinician`.
- First user bootstrapped as admin via migration; admins invite further team members from an Admin page (creates auth user + assigns `clinician` role).
- Public sign-up disabled; `/auth` page only handles sign-in + password reset.
- Route gating: all app routes live under `_authenticated/`; admin pages additionally gated by `has_role(uid, 'admin')`.

### Tables (all RLS-enabled, `TO authenticated` only)
1. **profiles** — id (FK auth.users), full_name, job_title, created_at. Auto-created via trigger on signup.
2. **user_roles** — id, user_id, role (enum). Checked via `has_role()` security-definer function.
3. **referrals** — all ICNARC + clinical fields:
   - Patient: age, sex, hospital_number, current_ward, current_bed, pmh, baseline_function, dnacpr_respect (bool), referring_specialty, reason_for_referral
   - Timestamps: referral_received_at, first_seen_at, decision_at, arrived_on_unit_at
   - Outcome: status (`pending`, `declined`, `admitted`), decline_reason
   - Meta: created_by, updated_by, created_at, updated_at
4. **referral_notes** — id, referral_id, author_id, body, created_at (append-only short notes).
5. **audit_log** — id, user_id, action (`view`/`create`/`update`/`delete`), entity (`referral`/`note`), entity_id, diff (jsonb), created_at. Insert allowed for all authenticated users; SELECT restricted to admins.
6. **notifications** — id, user_id, referral_id, kind (`new`/`updated`), message, read_at, created_at. Per-user notification feed.

### RLS summary
- referrals / referral_notes: any authenticated clinician may SELECT, INSERT, UPDATE. DELETE restricted to admins.
- audit_log: INSERT for authenticated; SELECT admin only.
- notifications: user can only read/update their own.
- user_roles: SELECT for authenticated; INSERT/UPDATE/DELETE admin only.

### Server functions (`createServerFn` + `requireSupabaseAuth`)
- `createReferral`, `updateReferral`, `addNote` — write data, append audit log row, and fan out notifications to all other clinicians.
- `logView` — fire-and-forget audit row when a referral detail page is opened.
- `inviteClinician` — admin-only; uses `supabaseAdmin` to create auth user with temp password + email reset link.
- `getAnalytics` — server-side aggregations for the dashboard.

## Frontend

TanStack Start app with the existing stack. Sidebar layout once logged in.

### Pages
1. **/auth** — sign-in + forgot-password. No self sign-up.
2. **/** (Referrals list) — sortable/filterable table of all referrals, status badges, search by hospital number/ward, "New referral" button. Live updates via Supabase realtime on the `referrals` table.
3. **/referrals/new** — full referral form with sectioned fields (Patient details, Clinical, Timestamps, Outcome). Zod validation, sensible defaults (received_at = now).
4. **/referrals/$id** — full detail view with inline edit, timeline of timestamps, notes thread (add brief note), audit history (admins only). Logs a view on mount.
5. **/analytics** — dashboard with charts (Recharts):
   - Referrals over time (line, daily/weekly toggle)
   - Mean referrals per 24h (KPI card, rolling 7/30 day)
   - Referrals by specialty (bar)
   - Outcome breakdown — admitted / declined / pending (donut)
   - Mean age, sex split, mean time-to-first-seen, mean decision-to-arrival (KPI cards)
   - Date range filter.
6. **/admin** (admin role only) — list users, invite clinician, change roles, view audit log with filters.

### Notifications
- In-app: bell icon in the header with unread count; dropdown list of recent notifications; click to jump to the referral. Realtime subscription to `notifications` for current user.
- Browser: on first sign-in, prompt for `Notification.requestPermission()`. When a realtime insert arrives and the tab is not focused, fire a `new Notification(...)`. Stored as a per-user preference (toggle in profile menu).
- Push triggered by `createReferral` / `updateReferral` / `addNote` server functions writing one notification row per other clinician.

### Design
Clean clinical UI — calm slate/teal palette, generous spacing, high-contrast typography (Inter), shadcn components, status colour coding (amber pending / green admitted / red declined). Mobile-friendly so it's usable on a phone at the bedside.

## Information governance notes shown to user
- HTTPS + at-rest encryption + RLS provides standard NHS-internal-tool security, but this app is **not** a certified medical device or DSPT-assessed system. Before using with real patient data, the trust's Caldicott Guardian / IG team should review and a DPIA should be completed.
- Audit log is append-only and admin-visible.

## Out of scope (can add later)
- SSO / NHS smartcard.
- Field-level encryption of identifiers.
- Mobile PWA install + true background push.
- Export to ICNARC CMP format.
