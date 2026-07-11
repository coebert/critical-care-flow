# Cybersecurity review — SDH Critical Care

App is an NHS critical care handover / referral / bed board system on TanStack Start + Lovable Cloud (Supabase). Handles patient identifiers, clinical notes (E2E encrypted), a partner bridge, WebAuthn/passkeys, push notifications, and privileged admin flows. Automated scanners (Supabase advisor, supply-chain, agent, MCP) are all clean at the time of review; findings below come from manual review of the source.

## What is already strong

- Roles in a separate `user_roles` table with `has_role()` SECURITY DEFINER — no privilege-escalation smell.
- RLS enabled everywhere in `public`; per-table GRANTs present in migrations.
- E2E encryption for clinical notes (X25519 sealed box, Argon2id-wrapped keys, client-side only).
- Patient identifiers stored as AES-GCM ciphertext + HMAC lookup hash.
- Bridge endpoints use HMAC with timestamp skew + previous-secret rotation and timing-safe compare.
- Auth throttle via `begin/finalize_auth_attempt` RPCs under `pg_advisory_xact_lock`.
- Just-fixed: cron-triggered bridge routes no longer accept the public anon key (`bridge_sync_anon_key`).
- Idle + absolute session caps, HIBP password check, sign-ups disabled at provider level.
- Comprehensive audit_log with service-role-only writes and admin-only reads.

## Findings (prioritised)

Severity uses: **P1** exploitable now / clinical-safety impact, **P2** meaningful hardening, **P3** defence-in-depth / hygiene.

### P1 — address first

1. **Runtime hydration mismatch on `/auth`** (already visible in the runtime error log). Hydration failures cause React to re-render the whole tree client-side; on an auth page this can flash unauthenticated UI, break CSRF-relevant state, and mask XSS regressions. Root-cause the branch in `src/routes/auth.tsx` around line 225 (likely a `typeof window` or `Date.now()`-style read in render).

2. **`/setup` bootstrap endpoint hardening.** `src/routes/setup.tsx` uses `supabaseAdmin.auth.admin.createUser` gated only by "no users exist yet" + auth throttle. Confirm:
   - It is race-safe (two concurrent setup calls cannot both create an admin).
   - It is disabled/no-ops once `handle_new_user`'s admin bootstrap has run.
   - The endpoint requires a one-time `SETUP_SECRET` (there is an `e2e/setup-secret-gate.spec.ts`, verify it still enforces in production, not just e2e).

3. **Server-function endpoints without a role gate are public on the published site.** Audit every `createServerFn` under `src/lib/*.functions.ts` for a `.middleware([requireSupabaseAuth])` AND, where privileged, an `assertAdmin` / `assertClinicalAccess` call. Focus files: `admin.functions.ts`, `bridge-status.functions.ts`, `capacity-alerts.functions.ts`, `patient-acuity.functions.ts`, `analytics.functions.ts`, `partner-bed-board.functions.ts`, `test-capacity-push.functions.ts` (test endpoints must not ship privileged behaviour to prod).

4. **`x-cron-secret` handling defence-in-depth.** The new `bridge_cron_secret` lives in `vault.decrypted_secrets` and is fetched via `get_bridge_cron_secret()` RPC. Verify:
   - RPC is `EXECUTE` granted **only** to `service_role` (not `authenticated`/`anon`).
   - `isBridgeCallerAuthorized` uses `timingSafeEqual` on equal-length buffers and rejects missing headers instead of falling through.
   - Rotate `HANDOVER_API_SECRET` and `bridge_cron_secret` on a schedule; document in `docs/SECURE_DEVELOPMENT.md`.

### P2 — meaningful hardening

5. **HTTP security headers.** No evidence of a Content-Security-Policy, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `Strict-Transport-Security`, or `X-Content-Type-Options` being emitted from the SSR shell. Add them in `src/routes/__root.tsx` head + a response header middleware. CSP is the highest value; start in report-only.

6. **CORS on bridge routes is `*`.** `bridgeCorsHeaders` allows any origin with credentials-free but signed requests. Tighten `Access-Control-Allow-Origin` to the known partner origin(s) via allowlist echo; keep `*` only for `OPTIONS` preflight where truly needed.

7. **`audit_log` completeness.** Confirm every privileged path writes to `audit_log`: role changes, setup bootstrap, keypair reissue, bridge manual runs, admin invite, notification/PHI reads. Any surface that returns patient data without an audit row is a gap for DTAC/DSPT evidence.

8. **Passkey / WebAuthn flow — challenge lifecycle.** `webauthn_challenges` rows are deleted after use; verify:
   - Challenges expire (TTL enforced in DB, not just app code).
   - RP ID / origin is pinned to production hostnames (no wildcard).
   - Counter regression is rejected (clone detection).

9. **Notification / deep-link error path**  already tested (`inaccessible-referral-deep-link-flow`, `repeated-invalid-notification-deep-link-flow`). Extend audit assertions to cover: signed-out click, cross-tenant click, admin-impersonation click — all must write `notification_id = null` and never leak referral fields to the client.

10. **Rate limiting beyond auth.** `begin_auth_attempt` throttles signin/reset/setup. Consider per-user throttles on: password change, keypair reissue, admin invite, bridge manual sync, test-push, notification enumeration. A signed-in attacker with stolen creds otherwise has unlimited attempts at these.

11. **Push subscription hygiene.** `claim_push_subscription` binds an endpoint to the calling user, but does not verify the caller owned it previously — an attacker who learns another user's endpoint URL can steal delivery. Reject `INSERT` when the endpoint already exists under a different `user_id`, and audit the takeover attempt.

12. **Service-worker (`public/sw-push.js`) review.** Ensure it does not `postMessage` decrypted payloads to unscoped clients, does not open arbitrary URLs from the push payload (only same-origin path from an allowlist), and validates payload shape.

13. **Client-side storage of sensitive material.** E2E private keys are Argon2id-wrapped, good — but confirm the wrapped material and any derived keys live only in memory / IndexedDB with the tab lifetime, not `localStorage`. Check `use-e2e-session.ts` and `e2e-unlock-modal.tsx`.

14. **Dependency & lockfile hygiene.** Supply-chain scan is stale (2026-07-08). Re-run before each release; add a CI step that fails on High/Critical.

### P3 — hygiene & long-tail

15. **Secrets inventory prune.** `SUPABASE_PUBLISHABLE_KEY` is stored as a runtime secret but is public — harmless, but remove from the runtime secret store to reduce cognitive load about which secrets are private.

16. **Test endpoints in production.** `src/routes/_authenticated/push-test.tsx` and `src/lib/test-capacity-push.functions.ts` should be admin-only or feature-flagged off in production.

17. **Error surfaces.** Every route with a loader must set `errorComponent`/`notFoundComponent` (per house rules) with sanitised messages — no raw Supabase `message`/`hint` in the UI. Sweep components in `src/components/referral-route-error.tsx` and analogues.

18. **DTAC evidence log.** `docs/dtac/README.md` should record: last restore drill, last pen-test, current STRIDE / DPIA revision, key-rotation dates. Update on every relevant change.

19. **CI enforcement.** Add lint rules that ban: `localStorage.setItem(...token/secret/key...)`, `dangerouslySetInnerHTML`, `eval`/`new Function`, and top-level `import ... client.server` from `*.functions.ts`.

20. **Vulnerability disclosure end-to-end.** `/security` and `SECURITY.md` exist — add an out-of-band contact + PGP key and confirm the mailbox is monitored.

## Delivery plan

Split into three PR-sized batches; each is independently deployable and testable.

### Batch A — P1 (this week)

- Fix `/auth` hydration mismatch.
- Audit every `createServerFn` for auth + role middleware; add missing gates + integration tests that assert 401/403 for signed-out and non-privileged callers.
- Harden `/setup` (grants on `get_bridge_cron_secret`, race-safety re-check, SETUP_SECRET enforced in prod).
- Add integration test: `x-cron-secret` header is required, timing-safe, and never falls through to the anon key.

### Batch B — P2 (next 1–2 weeks)

- SSR security headers + CSP (report-only → enforce).
- Tighten bridge CORS to a partner allowlist.
- Push subscription takeover protection + audit row.
- Extend deep-link + audit tests for the missing edge cases (signed-out, cross-tenant, impersonation).
- Rate limit privileged surfaces (invite, reissue, manual sync, test push).
- Passkey RP ID pinning + challenge TTL check.

### Batch C — P3 (rolling)

- Prune redundant secrets; feature-flag test endpoints; sweep sanitised error surfaces.
- CI lints for dangerous patterns; scheduled dependency scan.
- DTAC/DSPT evidence refresh; SECURITY.md contact hardening.

## Verification approach

For each fix:

1. **Server-fn gate tests** — mock the auth middleware and assert both `Unauthorized` for missing session and `Forbidden` for wrong role, using the existing `makeCtx` pattern.
2. **DB policy tests** — a Vitest that opens two Supabase clients (anon + `authenticated` under two different user IDs) and asserts each table's SELECT/INSERT/UPDATE/DELETE behaves per the intended matrix.
3. **Playwright smoke** for headers, CSP, sign-in throttle, deep-link error toast, and the `/setup` bootstrap being closed after first admin.
4. **Manual review checklist** committed under `docs/dtac/security-review-2026-07.md` capturing what was reviewed, what changed, and who signed it off.

## Out of scope for this plan

- Provider-managed infrastructure (Supabase / Cloudflare edge) — covered by their SOC 2.
- Physical/organisational NHS controls.
- Formal external pen-test — recommend scheduling once Batch A + B ship.
