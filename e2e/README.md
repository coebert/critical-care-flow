# End-to-end tests (Playwright)

These tests drive the real app in a real browser to verify that the
ICNARC timestamp validation blocks saving and highlights the right
fields. They are intentionally non-destructive: the only test that
clicks **Save** is one that expects the save to be rejected.

## One-time setup

```bash
bunx playwright install chromium
```

## Required environment variables

| Variable        | Purpose                                                |
| --------------- | ------------------------------------------------------ |
| `E2E_BASE_URL`  | URL of a running preview, e.g. `http://localhost:5173` |
| `E2E_EMAIL`     | Email of a real test user in Lovable Cloud auth        |
| `E2E_PASSWORD`  | Password for that user                                 |

The `setup` project signs in once with these credentials and writes a
storage state to `e2e/.auth/user.json`, which all other tests reuse.

## Running

```bash
# headless
E2E_BASE_URL=http://localhost:5173 \
E2E_EMAIL=test@example.com \
E2E_PASSWORD=... \
bunx playwright test

# interactive
bunx playwright test --ui
```

## What is covered

`e2e/referral-timings.spec.ts`:

- Missing `referral_received_at` blocks save.
- Admitted status with empty first-seen / decision / arrived blocks save
  and highlights all three fields.
- Future `referral_received_at` is rejected (with > 2 min skew).
- Future `first_seen_at` on an admitted referral is rejected.
- `first_seen_at` before `referral_received_at` is flagged in both the
  field and the "Inconsistent timings" alert.
- `decision_at` before `first_seen_at` is flagged.
- `arrived_on_unit_at` before `decision_at` is flagged.
- A fully chronological admitted referral shows no timing errors.
