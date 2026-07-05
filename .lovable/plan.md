# Passkey (WebAuthn) sign-in

Add passkeys as a full password replacement on any device with platform biometrics (Face ID, Touch ID, Windows Hello, Android). Password sign-in stays available as a fallback for devices with no passkey yet.

## User flow

1. **Sign in** page gains a "Sign in with a passkey" button above the email/password form. Enter email → device biometric prompt → signed in.
2. **After a successful password sign-in on a passkey-capable device with no passkey yet**, show a one-time modal: "Set up a passkey for faster sign-in?" → biometric prompt → passkey enrolled. User can dismiss ("Not now" / "Don't ask on this device").
3. **Profile page** gets a "Passkeys" section: list registered passkeys (device label, last used, created), "Add another passkey", remove.

## Data model (new migration)

- `public.webauthn_credentials` — one row per passkey
  - `id uuid pk`, `user_id uuid → auth.users`, `credential_id text unique`, `public_key bytea`, `counter bigint`, `transports text[]`, `device_label text`, `aaguid uuid`, `created_at`, `last_used_at`
  - RLS: owner can `SELECT`/`DELETE` their own; inserts/updates go through server functions with `supabaseAdmin`.
- `public.webauthn_challenges` — short-lived ceremony state
  - `id uuid pk`, `challenge text`, `user_id uuid null`, `email_norm text null`, `kind text check in ('registration','authentication')`, `expires_at timestamptz` (2 min)
  - No client access — service-role only. Cleaned up on verify + on expiry.
- Standard `GRANT` + RLS blocks per project convention.

## Server functions (`src/lib/webauthn.functions.ts`)

Uses `@simplewebauthn/server` (edge-compatible).

- `startPasskeyRegistration` — auth-required. Generates registration options, stores challenge keyed to `userId`, returns options.
- `verifyPasskeyRegistration({ response, deviceLabel })` — auth-required. Verifies attestation, inserts credential row.
- `startPasskeyAuthentication({ email })` — public. Loads user's credentials (via `supabaseAdmin`), issues challenge keyed to `email_norm`, returns options with `allowCredentials`. Returns generic response whether or not the email exists (no account enumeration).
- `verifyPasskeyAuthentication({ email, response })` — public. Verifies assertion, bumps counter + `last_used_at`, then mints a session via `supabaseAdmin.auth.admin.generateLink({ type: 'magiclink', email })` and returns the `hashed_token` + `email`. Client calls `supabase.auth.verifyOtp({ token_hash, type: 'magiclink' })` to hydrate the real session. Rate-limited via existing `begin_auth_attempt`/`finalize_auth_attempt` (`_attempt_type = 'signin'`).
- `listMyPasskeys` / `deleteMyPasskey({ id })` — auth-required, owner-scoped.

## Client (`@simplewebauthn/browser`)

- `src/lib/passkeys.ts` — thin helpers: `isPasskeySupported()`, `signInWithPasskey(email)`, `registerPasskey(deviceLabel?)`, capability detection (`PublicKeyCredential.isConditionalMediationAvailable`, `isUserVerifyingPlatformAuthenticatorAvailable`).
- **Auth page** (`src/routes/auth.tsx`): "Sign in with a passkey" button (visible only when supported). On success → `verifyOtp` → navigate to `postAuthTarget`. Errors surface via existing toast.
- **Post-signin prompt**: after `signInWithPassword` succeeds, check platform-authenticator availability and `listMyPasskeys` count === 0 and no `localStorage['passkey:dismissed']`. If all true, open a modal with Enable / Not now / Don't ask again on this device.
- **Profile page** (`src/routes/_authenticated/profile.tsx`): new "Passkeys" card — list, remove (with confirm), add another.

## Security notes

- All ceremonies use ≤2 min server-issued challenges tied to user or email; challenge rows are single-use and deleted on verify.
- `rpId = window.location.hostname`, origin allow-list = `window.location.origin` on the server (using request `Origin` header, matched against the app's own origin only).
- `userVerification: 'required'` — biometric/PIN gate is mandatory.
- `attestationType: 'none'` — no vendor attestation data stored (privacy).
- Passkey sign-in flows through the same `auth_throttle` limits as password sign-in.
- No account enumeration: `startPasskeyAuthentication` returns opaque options for unknown emails (random `allowCredentials` seed).
- `webauthn_credentials` never exposes `public_key` to the client; RLS SELECT hides that column via a view or by only returning safe columns from `listMyPasskeys`.

## Dependencies

```
bun add @simplewebauthn/browser @simplewebauthn/server
```

Both are pure JS and edge/worker-compatible.

## Files

- new: `supabase/migrations/<ts>_webauthn.sql`
- new: `src/lib/webauthn.functions.ts`
- new: `src/lib/passkeys.ts`
- new: `src/components/passkey-enroll-prompt.tsx`
- new: `src/components/passkey-list.tsx`
- edited: `src/routes/auth.tsx` (passkey sign-in button + post-signin prompt trigger)
- edited: `src/routes/_authenticated/profile.tsx` (passkeys card)
- edited: `src/integrations/supabase/types.ts` (regenerated)

## Out of scope (for this change)

- Conditional UI (autofill) — can be added later once base flow is solid.
- Cross-device sign-in via QR (hybrid transport is automatically supported by the browser API when the OS offers it; no extra work).
- Removing password sign-in entirely.
