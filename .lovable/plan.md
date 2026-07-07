## Point 6 — Communication (per-referral tasks, templates, referring-team message log)

Goal: give the coordinator/registrar a per-referral workspace for **tasks, snippet-driven communication, and a record of what was said to the referring team**, without inventing a real external chat surface (referring teams don't have accounts here).

### 1. Tasks per referral

New table `public.referral_tasks`:
- `id`, `referral_id (fk referrals, cascade)`, `title text`, `details text?`
- `assigned_role app_role?` (nullable = "anyone")
- `due_at timestamptz?`
- `status text` (`open` | `done` | `cancelled`) default `open`
- `created_by`, `completed_by`, `completed_at`, `created_at`, `updated_at`
- RLS: any clinician/admin can select/insert/update tasks on non-deleted referrals (mirrors referral_notes policy).
- Index `(referral_id, status)` and `(status, due_at)` for a "my open SLAs" query later.

Server fns in `src/lib/referral-tasks.functions.ts`:
- `listTasks({ referral_id })`
- `createTask({ referral_id, title, details?, assigned_role?, due_at? })`
- `updateTask({ id, patch })` — title/details/due/assigned/status. Auto-stamp `completed_by/at` on transition to `done`.
- `deleteTask({ id })` — admin only.

UI: `src/components/referrals/task-list.tsx` on the referral page — inline add row, checkbox to complete, badge for overdue (due_at < now, status=open) using existing timer/format helpers.

### 2. Message templates (decline/advice snippets)

New table `public.message_templates` (admin-managed, everyone reads):
- `id`, `title text`, `category text` (`decline` | `advice` | `plan` | `handover`), `body text`, `active bool default true`, `created_by`, `created_at`, `updated_at`.
- Seed 6 defaults in the migration (ward NIV trial, ceiling of care, etc.).
- RLS: `SELECT` for authenticated; `INSERT/UPDATE/DELETE` admin-only.

Server fns in `src/lib/message-templates.functions.ts`:
- `listTemplates({ category? })`
- `upsertTemplate`, `deleteTemplate` (admin-only via `has_role`).

UI:
- `src/components/referrals/template-picker.tsx` — a dropdown that inserts the body into a target textarea (used by note composer and the new outbound-message form).
- Admin management panel `src/components/admin/message-templates-panel.tsx` mounted on `/admin`.

### 3. Referring-team message log

New table `public.referral_messages` (record of outbound communication to the referring team — not a live chat surface):
- `id`, `referral_id`, `channel text` (`phone` | `bleep` | `email` | `secure_msg` | `in_person`), `direction text` (`outbound` | `inbound`), `recipient text?` (name/bleep), `body text`, `template_id uuid?`, `sent_by uuid`, `sent_at timestamptz default now()`, `created_at`.
- RLS: clinician/admin read+insert on non-deleted referrals; update/delete admin-only.

Server fns in `src/lib/referral-messages.functions.ts`: `listMessages`, `logMessage`, `deleteMessage` (admin).

UI: `src/components/referrals/message-log.tsx` — chronological list with channel icon + direction chip; "Log message" dialog that accepts channel/direction/recipient/body and a template picker to prefill body.

### 4. Referral page integration

On `src/routes/_authenticated/referrals.$id.tsx`, add two new sections after the notes area:
- **Tasks** (task list component)
- **Communication log** (message log component)
Template picker also wired into the existing note composer as an "Insert template" button.

### 5. Shared helpers & tests

- `src/lib/referral-tasks.ts` — status labels, overdue helper.
- `src/lib/message-templates.ts` — category labels, seed defaults.
- Tests: `referral-tasks.test.ts` (overdue math, status transitions), `message-templates-authz.test.ts` (admin-only mutation), `referral-messages.test.ts` (log shape validation).

### Out of scope

- Real inbound messaging from referring teams (requires external identity).
- Notifications from tasks (Point 8 territory).
- SMS delivery (Point 6 in original clinical list mentions SMS on cancellation — that belongs to a later notifications pass).

### Size

1 migration, ~14 files, ~700 lines. Additive, no breaking changes.

Implementation order: migration → server fns → shared utils → components → route integration → admin panel → tests.