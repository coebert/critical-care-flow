// Client-side end-to-end encryption helpers for the referral noteboard.
//
// All plaintext handling stays in the browser. The server only ever sees
// ciphertext + wrapped-per-recipient content keys.
//
// Scheme:
//   * Per-user long-term keypair: X25519 (crypto_box).
//   * Per-note content key: 32 random bytes.
//   * Body encryption: XChaCha20-Poly1305 (crypto_secretbox) with a random 24-byte nonce.
//   * Content-key wrapping to each recipient: crypto_box_seal (anonymous sealed box)
//     to the recipient's X25519 public key.
//   * Private key at rest: crypto_secretbox with an Argon2id-derived key from the
//     user's password. Stored server-side but unreadable without the password.

// The default `libsodium-wrappers` build omits the Argon2 (`crypto_pwhash*`)
// functions, so calling `crypto_pwhash` there throws "length cannot be null
// or undefined" (the constants come back undefined). The `-sumo` build is
// API-compatible and includes password hashing, which we need to wrap the
// user's private key with their password.
import _sodium from "libsodium-wrappers-sumo";

let ready: Promise<typeof _sodium> | null = null;
export async function sodium() {
  if (!ready) {
    ready = (async () => {
      await _sodium.ready;
      return _sodium;
    })();
  }
  return ready;
}

export interface KeyPairB64 {
  publicKey: string;
  privateKey: string; // NEVER sent to server as plaintext
}

export interface PrivateKeyMaterial {
  encrypted_private_key: string;
  kdf_salt: string;
  kdf_ops: number;
  kdf_mem: number;
  nonce: string;
}

const KDF_OPS = 3; // sodium.crypto_pwhash_OPSLIMIT_MODERATE
const KDF_MEM = 268435456; // sodium.crypto_pwhash_MEMLIMIT_MODERATE (256 MiB)

async function deriveKeyFromPassword(
  password: string,
  saltB64: string,
  ops: number,
  mem: number,
): Promise<Uint8Array> {
  const s = await sodium();
  const salt = s.from_base64(saltB64, s.base64_variants.ORIGINAL);
  return s.crypto_pwhash(
    32,
    password,
    salt,
    ops,
    mem,
    s.crypto_pwhash_ALG_ARGON2ID13,
  );
}

/** Generate a fresh keypair and wrap the private key with the user's password. */
export async function generateAndWrapKeypair(password: string): Promise<{
  keypair: KeyPairB64;
  material: PrivateKeyMaterial;
}> {
  const s = await sodium();
  const kp = s.crypto_box_keypair();
  const salt = s.randombytes_buf(s.crypto_pwhash_SALTBYTES);
  const saltB64 = s.to_base64(salt, s.base64_variants.ORIGINAL);
  const kek = await deriveKeyFromPassword(password, saltB64, KDF_OPS, KDF_MEM);
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const ct = s.crypto_secretbox_easy(kp.privateKey, nonce, kek);
  return {
    keypair: {
      publicKey: s.to_base64(kp.publicKey, s.base64_variants.ORIGINAL),
      privateKey: s.to_base64(kp.privateKey, s.base64_variants.ORIGINAL),
    },
    material: {
      encrypted_private_key: s.to_base64(ct, s.base64_variants.ORIGINAL),
      kdf_salt: saltB64,
      kdf_ops: KDF_OPS,
      kdf_mem: KDF_MEM,
      nonce: s.to_base64(nonce, s.base64_variants.ORIGINAL),
    },
  };
}

/** Attempt to decrypt the stored private key using the supplied password. */
export async function unwrapPrivateKey(
  password: string,
  material: PrivateKeyMaterial,
): Promise<Uint8Array> {
  const s = await sodium();
  const kek = await deriveKeyFromPassword(
    password,
    material.kdf_salt,
    material.kdf_ops,
    material.kdf_mem,
  );
  const ct = s.from_base64(material.encrypted_private_key, s.base64_variants.ORIGINAL);
  const nonce = s.from_base64(material.nonce, s.base64_variants.ORIGINAL);
  try {
    return s.crypto_secretbox_open_easy(ct, nonce, kek);
  } catch {
    throw new Error("Incorrect password — could not unlock encrypted notes.");
  }
}

/** Re-wrap an already-known private key under a new password (for password rotation). */
export async function rewrapPrivateKey(
  privateKey: Uint8Array,
  newPassword: string,
): Promise<PrivateKeyMaterial> {
  const s = await sodium();
  const salt = s.randombytes_buf(s.crypto_pwhash_SALTBYTES);
  const saltB64 = s.to_base64(salt, s.base64_variants.ORIGINAL);
  const kek = await deriveKeyFromPassword(newPassword, saltB64, KDF_OPS, KDF_MEM);
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const ct = s.crypto_secretbox_easy(privateKey, nonce, kek);
  return {
    encrypted_private_key: s.to_base64(ct, s.base64_variants.ORIGINAL),
    kdf_salt: saltB64,
    kdf_ops: KDF_OPS,
    kdf_mem: KDF_MEM,
    nonce: s.to_base64(nonce, s.base64_variants.ORIGINAL),
  };
}

export interface EncryptedNote {
  body_ciphertext: string; // base64
  body_nonce: string; // base64
  enc_version: number;
  wrapped_keys: Array<{ recipient_user_id: string; wrapped_key: string }>;
}

/**
 * Encrypt a plaintext note body for a set of recipients (identified by
 * user id + X25519 public key). Returns the ciphertext + a per-recipient
 * sealed content key.
 */
export async function encryptNote(
  plaintext: string,
  recipients: Array<{ user_id: string; public_key: string }>,
): Promise<EncryptedNote> {
  const s = await sodium();
  if (recipients.length === 0) {
    throw new Error(
      "No teammates have enabled end-to-end encryption yet — cannot send an encrypted note.",
    );
  }
  const contentKey = s.randombytes_buf(s.crypto_secretbox_KEYBYTES);
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const ct = s.crypto_secretbox_easy(plaintext, nonce, contentKey);
  const wrapped = recipients.map((r) => {
    const pub = s.from_base64(r.public_key, s.base64_variants.ORIGINAL);
    const sealed = s.crypto_box_seal(contentKey, pub);
    return {
      recipient_user_id: r.user_id,
      wrapped_key: s.to_base64(sealed, s.base64_variants.ORIGINAL),
    };
  });
  return {
    body_ciphertext: s.to_base64(ct, s.base64_variants.ORIGINAL),
    body_nonce: s.to_base64(nonce, s.base64_variants.ORIGINAL),
    enc_version: 1,
    wrapped_keys: wrapped,
  };
}

/** Decrypt a note body using the current user's wrapped content key + private key. */
export async function decryptNote(
  args: {
    body_ciphertext: string;
    body_nonce: string;
    wrapped_key: string;
  },
  ownKeypair: { publicKey: string; privateKey: Uint8Array },
): Promise<string> {
  const s = await sodium();
  const sealed = s.from_base64(args.wrapped_key, s.base64_variants.ORIGINAL);
  const pub = s.from_base64(ownKeypair.publicKey, s.base64_variants.ORIGINAL);
  const contentKey = s.crypto_box_seal_open(sealed, pub, ownKeypair.privateKey);
  const ct = s.from_base64(args.body_ciphertext, s.base64_variants.ORIGINAL);
  const nonce = s.from_base64(args.body_nonce, s.base64_variants.ORIGINAL);
  const pt = s.crypto_secretbox_open_easy(ct, nonce, contentKey);
  return s.to_string(pt);
}
