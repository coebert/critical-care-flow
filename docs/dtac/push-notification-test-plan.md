# Push notification test plan — referrals

Scope: verify that creating and updating a referral reliably fans out the
right notifications to the right recipients, honouring each user's per-kind
push preferences and shift status.

This plan has two layers:

1. **Unit-level (fast, deterministic, always run in CI)** — pure tests of
   `selectRecipients` and `fanOutNotifications` in
   `src/lib/notification-fanout.ts` covering the full preference matrix.
   Lives in:
   - `src/lib/notification-fanout.test.ts` (shift + role + actor filters)
   - `src/lib/notification-fanout-prefs.test.ts` (per-kind preference matrix)
2. **Browser end-to-end (Playwright, requires a running preview and two
   test users)** — drives the real UI to toggle preferences and asserts
   the notification inbox updates as expected.
   Lives in `e2e/push-notification-prefs.spec.ts`.

## Invariants under test

For every event kind (`new`, `updated`), a user receives an in-app
notification **and** a web-push if and only if all of these are true:

- They hold an `admin` or `clinician` role.
- They are marked `is_at_work = true` on their profile.
- They are not the actor who triggered the event.
- Their per-kind preference is not `false`:
  - `new` → `profiles.notify_new_referral !== false`
  - `updated` → `profiles.notify_updated_referral !== false`
- (Push only) they have at least one live push subscription.

Undefined / null preferences default to **opted-in** (matches the DB
default of `TRUE` and the client-side fallback in
`getNotificationPrefs`).

## Preference matrix

Five personas, each at work with the clinician role and one push
subscription. Only their per-kind flags differ:

| Persona          | notify_new_referral | notify_updated_referral | Receives `new`? | Receives `updated`? |
| ---------------- | ------------------- | ----------------------- | --------------- | ------------------- |
| `u-default`      | undefined           | undefined               | yes             | yes                 |
| `u-both-on`      | true                | true                    | yes             | yes                 |
| `u-new-off`      | false               | true                    | no              | yes                 |
| `u-updated-off`  | true                | false                   | yes             | no                  |
| `u-both-off`     | false               | false                   | no              | no                  |

Each row is asserted twice per kind: once for the in-app row inserted
into `notifications`, once for the endpoint list handed to `sendPush`.

## Edge cases covered by unit tests

- Actor is never notified even with prefs ON and at work.
- Off-shift users are never notified even with prefs ON.
- Non-clinical roles are never notified.
- Duplicate role rows are deduped.
- Prefs are independent per kind — turning `new` OFF does not affect
  `updated`, and vice versa.
- If every eligible user has the relevant pref OFF, `insertNotifications`
  and `sendPush` are not called at all.
- Push failures do not block in-app notifications.
- Expired push endpoints (404/410) are pruned via `deletePushSubs`.

## Browser E2E flow

The Playwright spec `e2e/push-notification-prefs.spec.ts` uses the shared
storage state from `global.setup.ts` and a second reviewer account
(`E2E_REVIEWER_EMAIL` / `E2E_REVIEWER_PASSWORD`). For each pref state it:

1. Signs in as the reviewer, opens `/notifications`, sets the relevant
   switch, and confirms the "at work" toggle is on.
2. Signs in as the primary actor in a second browser context, creates a
   referral (kind = `new`) or edits an existing one (kind = `updated`).
3. Waits for the reviewer's `/inbox` (or the notification bell) to either
   show or NOT show a fresh entry within 15 s, matching the matrix row.

Because web-push delivery through the OS is out of scope for a headless
browser, the E2E layer asserts only the **in-app** notification row —
which is inserted synchronously in the same fanout call as the push and
therefore proves the pref filter fired correctly. Web-push endpoint
selection is covered by the unit tests above.

## How to run

```bash
# Unit + preference matrix — always green in CI
bunx vitest run src/lib/notification-fanout.test.ts src/lib/notification-fanout-prefs.test.ts

# Browser E2E — needs preview + two accounts
E2E_BASE_URL=http://localhost:5173 \
E2E_EMAIL=clinician1@example.com E2E_PASSWORD=... \
E2E_REVIEWER_EMAIL=clinician2@example.com E2E_REVIEWER_PASSWORD=... \
bunx playwright test push-notification-prefs
```

## Ownership

- Owner: engineering (notification pipeline).
- Cadence: run on every PR touching `src/lib/notification-*`,
  `src/routes/_authenticated/notifications.tsx`, or the `profiles`
  notification columns.
- Add a new persona row to `notification-fanout-prefs.test.ts` whenever a
  new notification kind or preference flag is introduced.
