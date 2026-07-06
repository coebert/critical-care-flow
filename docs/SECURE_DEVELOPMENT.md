# Secure development lifecycle — SDH Critical Care

Maps to NHS DTAC section C5 (Technical Assurance) and NCSC Cyber
Essentials controls.

## Access control

- Sign-in via Supabase Auth (email + password, HIBP-checked) or WebAuthn
  passkeys.
- Sign-ups are disabled at the auth-provider level; users are invited by
  an administrator.
- Roles held in a dedicated `user_roles` table with a `SECURITY DEFINER`
  `has_role()` helper — never in `profiles`.
- Row-Level Security enabled on every user-data table; policies scope
  reads/writes to `auth.uid()` or an explicit role check.
- Idle session timeout (30 minutes) and absolute session cap (12 hours)
  enforced client-side with cross-tab activity sync.

## Cryptography

- Clinical note bodies use per-recipient X25519 sealed-box end-to-end
  encryption (libsodium). Private keys are wrapped with the user's
  password via Argon2id and never leave the browser.
- Patient identifiers (hospital number, when present) are stored as
  AES-GCM ciphertext plus an HMAC-SHA-256 hash for lookup — the plaintext
  identifier never lands in a queryable column.
- Server-side symmetric secrets (`APP_ENCRYPTION_KEY`, `APP_HMAC_KEY`) are
  provisioned as Supabase secrets; never checked into the repo.

## Auditability

- `audit_log` table records privileged actions (admin operations,
  keypair lifecycle, encrypted-note reads and writes).
- Only `service_role` can write; only admins can read via a scoped SELECT
  policy.

## Change management

- Every merge to `main` is a code review by a second developer.
- Automated checks on each build: `tsgo` typecheck, `vitest` unit tests,
  Playwright end-to-end tests.
- Dependency vulnerability scan (`bun`/`npm audit`) runs on every build;
  Critical/High findings block the release.
- Database schema changes go through versioned migrations under
  `supabase/migrations` and are reviewed for RLS + GRANT correctness
  before merge.

## Rate limiting

- Sign-in and password reset attempts are throttled server-side via the
  `begin_auth_attempt` / `finalize_auth_attempt` RPCs (5 failures per
  15 minutes per email + attempt type, atomic under
  `pg_advisory_xact_lock`).
- Passkey and E2E unlock flows inherit the same throttle when triggered
  from the sign-in UI.

## Secrets management

- No secrets in source control; verified by pre-commit lint and CI.
- Secrets are injected at build/runtime by the Lovable Cloud secret
  store. Rotation is a two-step process: mint a new secret, deploy,
  revoke the old.

## Backup and recovery

- The Supabase-managed Postgres instance uses provider-managed daily
  backups with point-in-time recovery.
- Restoration is exercised at least annually; test-restore evidence
  logged in `docs/dtac/README.md`.

## Vulnerability disclosure

- Public policy at `/security` and `SECURITY.md`.
- Coordinated disclosure contact monitored during working hours.

## Data handling

- Only invited NHS staff can create accounts.
- Patient data is stored inside a UK-region Postgres instance managed by
  the provider under a signed DPA.
- Retention windows are configurable per record type; a scheduled job
  purges records older than the configured window (see
  `docs/dtac/README.md`).
