
## Goal

Notes posted to the referral notes wall are encrypted in the browser to every current clinician's public key. The server (and DB) only ever sees ciphertext. Existing plaintext notes stay readable but a banner marks them as legacy/unencrypted.

## Crypto choices

- **Keypair per user**: X25519 (via `libsodium-wrappers` — battle-tested, small, works in browser + worker).
- **Message encryption**: for each note, generate a random 32-byte content key, encrypt the body with XChaCha20-Poly1305 (`crypto_secretbox`), then wrap that content key to every recipient's public key with `crypto_box_seal` (anonymous sealed box). One ciphertext body + N tiny wrapped keys.
- **Private key at rest**: encrypted with a key derived from the user's password using Argon2id (libsodium `crypto_pwhash`), stored server-side in a new `user_keys` table. Only the user can decrypt it — the server holds ciphertext + salt only.
- **Session unlock**: on sign-in the user is prompted once for their password to unlock the private key; the unwrapped key is kept in memory (never localStorage). If they refresh and the session is still valid but the key is gone, they're prompted to unlock again.
- **Key bootstrap**: first time a signed-in user has no `user_keys` row, we generate a keypair client-side using their current password (captured via an unlock modal), and publish the public key.

## Membership changes

- **New clinician joins**: they can decrypt notes posted **after** their public key is published. Historical encrypted notes are unreadable to them — this is inherent to per-recipient E2E and was called out in the question. UI shows "encrypted before you joined" for those.
- **Clinician removed / role revoked**: their existing decryptions can't be revoked (they already saw plaintext), but future notes stop wrapping to their key. The recipient list is "users with clinician or admin role at the moment of send".
- **Password change**: user re-wraps their private key with the new password-derived key in the same flow (client-side).

## Schema

New table `public.user_keys`:
- `user_id uuid pk references auth.users`
- `public_key bytea not null` — X25519 public key
- `encrypted_private_key bytea not null` — private key sealed with password-derived key
- `kdf_salt bytea not null`, `kdf_ops int not null`, `kdf_mem int not null` — Argon2id params
- `nonce bytea not null` — for the secretbox around the private key
- `created_at`, `updated_at`

Add to `public.referral_notes`:
- `body_ciphertext bytea` — XChaCha20-Poly1305 ciphertext (nullable; legacy rows keep `body`)
- `body_nonce bytea`
- `enc_version smallint` — starts at 1
- Keep existing `body text` for backward compatibility; new rows write `body = ''` (or null) and populate ciphertext columns.

New table `public.referral_note_keys`:
- `note_id uuid references referral_notes on delete cascade`
- `recipient_user_id uuid references auth.users`
- `wrapped_key bytea not null` — sealed-box of the content key to recipient's public key
- PK `(note_id, recipient_user_id)`

RLS:
- `user_keys`: user reads/writes own row; authenticated can read `user_id, public_key` of others (needed to encrypt to them). Enforced via a SECURITY DEFINER view or a policy that only exposes the public key column. Simplest: split into two tables — `user_public_keys` (readable by authenticated) and `user_private_key_material` (only owner). Cleaner.
- `referral_note_keys`: recipient can select their own row; author can insert rows during note creation.

Final table split:
- `user_public_keys` — `user_id, public_key`. `SELECT` for authenticated, `INSERT/UPDATE` own row only.
- `user_private_key_material` — private ciphertext + KDF params. Owner-only for all ops.

## Server functions

- `getPublicKeyDirectory` — returns `{user_id, public_key}` for every user with clinician or admin role. Called before composing a note.
- `publishUserKeys({public_key, encrypted_private_key, kdf_salt, kdf_ops, kdf_mem, nonce})` — first-time bootstrap or rotation.
- `getMyPrivateKeyMaterial` — returns the caller's encrypted private key + KDF params.
- `addEncryptedNote({referral_id, body_ciphertext, body_nonce, wrapped_keys: [{recipient_user_id, wrapped_key}]})` — writes note + all wrapped keys in one transaction. Fans out notifications as today (notification body just says "New note", never contains plaintext).
- Notification fan-out: keep, but drop any preview of the note body from the message.

## Client

- `src/lib/e2e-crypto.ts` — libsodium wrapper: `unlockPrivateKey(password)`, `encryptNote(plaintext, recipientPublicKeys)`, `decryptNote(note, wrappedKey, privateKey)`, `bootstrapKeys(password)`, `rotatePassword(oldPw, newPw)`.
- `src/hooks/use-e2e-session.ts` — in-memory private key + `isUnlocked` state, plus an unlock modal component.
- Referral detail page (`src/routes/_authenticated/referrals.$id.tsx`):
  - When rendering notes: for each note, if it has ciphertext, look up my `wrapped_key` and decrypt; if no wrapped key exists (I joined after), show "Encrypted — you weren't a recipient".
  - When submitting a note: fetch key directory → encrypt → wrap to each recipient → call `addEncryptedNote`.
  - If E2E not yet unlocked, show unlock prompt instead of the compose box.
- Legacy plaintext notes render as before with a small "legacy — not end-to-end encrypted" badge.

## Migration & rollout

1. Ship schema + server fns + client crypto library.
2. On next sign-in, users hit an "Enable end-to-end encryption" modal that captures their password and bootstraps their keypair.
3. Until every active clinician has published a public key, new notes will be encryptable only to those who have — show a warning listing users still to enable. Once everyone has, warning disappears.
4. Old notes are **not** migrated (server has no plaintext access anyway); they stay legacy.

## Out of scope

- Recovery for lost passwords (would need a recovery key or admin escrow, which weakens the model). Documented in a warning on the enable-E2E modal: forgetting your password means losing access to notes encrypted after your last key rotation.
- Retro-encrypting the existing plaintext notes.
- E2E for referral clinical fields (only the notes wall is in scope here).

## Files touched

- New: migration for `user_public_keys`, `user_private_key_material`, `referral_note_keys`, columns on `referral_notes`.
- New: `src/lib/e2e-crypto.ts`, `src/hooks/use-e2e-session.ts`, `src/components/e2e-unlock-modal.tsx`, `src/lib/e2e-keys.functions.ts`, `src/lib/encrypted-notes.functions.ts`.
- Edit: `src/routes/_authenticated/referrals.$id.tsx` (notes rendering + compose), `src/routes/__root.tsx` (mount unlock modal), `src/lib/notification-fanout.ts` (strip note body previews).
- Dep: `bun add libsodium-wrappers`.

Approve to build.
