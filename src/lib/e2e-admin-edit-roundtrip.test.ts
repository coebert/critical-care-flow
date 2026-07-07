/**
 * End-to-end crypto round-trip that mirrors the admin delete+reinsert edit
 * path on `referral_notes` / `referral_note_keys`.
 *
 * Scenario:
 *   1. Author (Alice) encrypts a note addressed to Bob and Carol.
 *   2. Bob and Carol both decrypt their wrapped content key → plaintext.
 *   3. Admin (Dave, NOT a recipient of the original note) edits the body:
 *      - generates a fresh content key
 *      - re-seals it to Bob and Carol's public keys
 *      - overwrites ciphertext, deletes old wrapped keys, inserts new ones
 *      (server DELETE+INSERT under referral_note_keys RLS)
 *   4. Bob and Carol must still decrypt the NEW body with their own
 *      private keys — and the OLD wrapped keys must no longer work
 *      (fresh content key + fresh nonce).
 *
 * This is a pure client-side crypto test — no DB. It guards the invariant
 * the admin-edit RLS fix is meant to preserve: an admin editing someone
 * else's note leaves the note readable to its recipients.
 */
import { describe, it, expect } from "vitest";
import { encryptNote, decryptNote, sodium } from "./e2e-crypto";

async function newUser(userId: string) {
  const s = await sodium();
  const kp = s.crypto_box_keypair();
  return {
    user_id: userId,
    public_key: s.to_base64(kp.publicKey, s.base64_variants.ORIGINAL),
    keypair: { publicKey: s.to_base64(kp.publicKey, s.base64_variants.ORIGINAL), privateKey: kp.privateKey },
  };
}

describe("encrypted-note admin edit round trip", () => {
  it("recipients decrypt correctly after admin delete+reinsert re-wraps keys", async () => {
    const alice = await newUser("alice");
    const bob = await newUser("bob");
    const carol = await newUser("carol");
    const dave = await newUser("dave-admin");

    // --- Step 1: author writes original note to Bob + Carol.
    const originalPlaintext = "Patient stable; awaiting bloods.";
    const original = await encryptNote(originalPlaintext, [
      { user_id: bob.user_id, public_key: bob.public_key },
      { user_id: carol.user_id, public_key: carol.public_key },
    ]);
    expect(original.wrapped_keys).toHaveLength(2);

    // --- Step 2: both recipients decrypt.
    const bobKey = original.wrapped_keys.find((w) => w.recipient_user_id === "bob")!;
    const carolKey = original.wrapped_keys.find((w) => w.recipient_user_id === "carol")!;
    expect(
      await decryptNote(
        { body_ciphertext: original.body_ciphertext, body_nonce: original.body_nonce, wrapped_key: bobKey.wrapped_key },
        bob.keypair,
      ),
    ).toBe(originalPlaintext);
    expect(
      await decryptNote(
        { body_ciphertext: original.body_ciphertext, body_nonce: original.body_nonce, wrapped_key: carolKey.wrapped_key },
        carol.keypair,
      ),
    ).toBe(originalPlaintext);

    // --- Step 3: admin Dave (not a recipient, not the author) edits the
    // note body. Client re-runs encryptNote — a fresh content key + nonce
    // is generated and re-sealed to the same recipient set using their
    // published public keys. Server then deletes old referral_note_keys
    // rows and inserts these new ones under the fixed RLS policy.
    const editedPlaintext = "Patient improving; step-down to HDU planned.";
    const edited = await encryptNote(editedPlaintext, [
      { user_id: bob.user_id, public_key: bob.public_key },
      { user_id: carol.user_id, public_key: carol.public_key },
    ]);

    // Fresh ciphertext / nonce / wrapped keys (never reuse the old ones).
    expect(edited.body_ciphertext).not.toBe(original.body_ciphertext);
    expect(edited.body_nonce).not.toBe(original.body_nonce);
    const newBobKey = edited.wrapped_keys.find((w) => w.recipient_user_id === "bob")!;
    const newCarolKey = edited.wrapped_keys.find((w) => w.recipient_user_id === "carol")!;
    expect(newBobKey.wrapped_key).not.toBe(bobKey.wrapped_key);
    expect(newCarolKey.wrapped_key).not.toBe(carolKey.wrapped_key);

    // --- Step 4: both recipients still decrypt the NEW body with their
    // own private keys. This is the invariant the admin-edit RLS fix
    // preserves — before the fix, INSERT of these new key rows was blocked
    // and both recipients ended up with an unreadable note.
    expect(
      await decryptNote(
        { body_ciphertext: edited.body_ciphertext, body_nonce: edited.body_nonce, wrapped_key: newBobKey.wrapped_key },
        bob.keypair,
      ),
    ).toBe(editedPlaintext);
    expect(
      await decryptNote(
        { body_ciphertext: edited.body_ciphertext, body_nonce: edited.body_nonce, wrapped_key: newCarolKey.wrapped_key },
        carol.keypair,
      ),
    ).toBe(editedPlaintext);

    // --- Regression guards.
    // Old wrapped key + new ciphertext must not decrypt (fresh content key).
    await expect(
      decryptNote(
        { body_ciphertext: edited.body_ciphertext, body_nonce: edited.body_nonce, wrapped_key: bobKey.wrapped_key },
        bob.keypair,
      ),
    ).rejects.toThrow();

    // A non-recipient (Dave, the editing admin) cannot decrypt — even
    // though he wrote the ciphertext, he never sealed the content key to
    // his own public key.
    await expect(
      decryptNote(
        { body_ciphertext: edited.body_ciphertext, body_nonce: edited.body_nonce, wrapped_key: newBobKey.wrapped_key },
        dave.keypair,
      ),
    ).rejects.toThrow();
  });

  it("re-encrypting with a reduced recipient set drops the removed reader", async () => {
    // Admin edit that intentionally excludes Carol (e.g. she left the team
    // and lost her key). Bob still reads; Carol's old wrapped key is
    // useless against the new ciphertext.
    const bob = await newUser("bob");
    const carol = await newUser("carol");

    const original = await encryptNote("v1", [
      { user_id: bob.user_id, public_key: bob.public_key },
      { user_id: carol.user_id, public_key: carol.public_key },
    ]);
    const carolOld = original.wrapped_keys.find((w) => w.recipient_user_id === "carol")!;

    const edited = await encryptNote("v2 — Carol excluded", [
      { user_id: bob.user_id, public_key: bob.public_key },
    ]);
    expect(edited.wrapped_keys).toHaveLength(1);

    const bobNew = edited.wrapped_keys.find((w) => w.recipient_user_id === "bob")!;
    expect(
      await decryptNote(
        { body_ciphertext: edited.body_ciphertext, body_nonce: edited.body_nonce, wrapped_key: bobNew.wrapped_key },
        bob.keypair,
      ),
    ).toBe("v2 — Carol excluded");

    await expect(
      decryptNote(
        { body_ciphertext: edited.body_ciphertext, body_nonce: edited.body_nonce, wrapped_key: carolOld.wrapped_key },
        carol.keypair,
      ),
    ).rejects.toThrow();
  });
});
