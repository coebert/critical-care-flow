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
// Dynamic import: the sumo build is ~400KB minified. Importing it lazily
// keeps it out of every chunk that merely `import`s a symbol from this
// module (types, small helpers), and lets Rollup emit a dedicated
// `libsodium-wrappers-sumo` chunk that only downloads when we actually
// need to encrypt / decrypt / derive.
type Sodium = typeof import("libsodium-wrappers-sumo").default;

let ready: Promise<Sodium> | null = null;
export async function sodium(): Promise<Sodium> {
  if (!ready) {
    ready = (async () => {
      const mod = await import("libsodium-wrappers-sumo");
      const s = (mod as unknown as { default: Sodium }).default ?? (mod as unknown as Sodium);
      await s.ready;
      return s;
    })();
  }
  return ready;
}

/**
 * Startup sanity check: confirm the libsodium build actually ships the
 * Argon2 password-hashing primitives we depend on to wrap/unwrap the user's
 * private key. The default `libsodium-wrappers` build omits these — if
 * someone ever swaps it back in, every enable/unlock flow would fail with
 * a cryptic "length cannot be null or undefined". This surfaces the
 * problem loudly at app boot instead.
 *
 * Returns `{ ok: true }` when the build is complete, or a structured error
 * describing which symbol is missing so the caller can render an
 * actionable message.
 */
export type SodiumHealth =
  | { ok: true }
  | { ok: false; missing: string[]; error?: string };

export async function verifySodiumPasswordHashing(): Promise<SodiumHealth> {
  try {
    const s = await sodium();
    const required = [
      "crypto_pwhash",
      "crypto_pwhash_SALTBYTES",
      "crypto_pwhash_ALG_ARGON2ID13",
      "crypto_secretbox_easy",
      "crypto_secretbox_open_easy",
      "crypto_box_keypair",
      "crypto_box_seal",
      "crypto_box_seal_open",
    ] as const;
    const missing = required.filter((k) => (s as any)[k] === undefined);
    if (missing.length > 0) return { ok: false, missing: [...missing] };

    // Smoke-test a real derivation with the smallest allowed cost so a
    // corrupt WASM build (constants present, function broken) still trips.
    const salt = s.randombytes_buf(s.crypto_pwhash_SALTBYTES);
    s.crypto_pwhash(
      32,
      "startup-check",
      salt,
      s.crypto_pwhash_OPSLIMIT_MIN,
      s.crypto_pwhash_MEMLIMIT_MIN,
      s.crypto_pwhash_ALG_ARGON2ID13,
    );
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      missing: ["crypto_pwhash"],
      error: err instanceof Error ? err.message : String(err),
    };
  }
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

/**
 * End-to-end verification for stored key material. Confirms that the
 * password the user just entered can unwrap the private key stored on the
 * server AND that the resulting private key is genuinely paired with the
 * published public key (a full encrypt → decrypt round-trip against a
 * sealed-box addressed to the public key).
 *
 * Returns a structured result with per-step outcomes so the settings UI
 * can show which specific check failed (e.g. "password unwraps, but the
 * private key doesn't match the published public key").
 */
export interface KeypairVerification {
  ok: boolean;
  publicKey: string | null;
  checks: {
    fetched_material: "ok" | "missing" | "error";
    unwrap_private_key: "ok" | "wrong_password" | "error" | "skipped";
    public_key_matches: "ok" | "mismatch" | "error" | "skipped";
    round_trip_encrypt_decrypt: "ok" | "failed" | "error" | "skipped";
  };
  error?: string;
}

export async function verifyStoredKeypair(
  password: string,
  material: PrivateKeyMaterial | null,
  publicKeyB64: string | null,
): Promise<KeypairVerification> {
  const checks: KeypairVerification["checks"] = {
    fetched_material: "ok",
    unwrap_private_key: "skipped",
    public_key_matches: "skipped",
    round_trip_encrypt_decrypt: "skipped",
  };

  if (!material || !publicKeyB64) {
    checks.fetched_material = "missing";
    return { ok: false, publicKey: publicKeyB64, checks };
  }

  const s = await sodium();

  // 1. Unwrap the private key.
  let priv: Uint8Array;
  try {
    priv = await unwrapPrivateKey(password, material);
    checks.unwrap_private_key = "ok";
  } catch (err) {
    const msg = err instanceof Error ? err.message.toLowerCase() : "";
    checks.unwrap_private_key = msg.includes("incorrect password") ? "wrong_password" : "error";
    return {
      ok: false,
      publicKey: publicKeyB64,
      checks,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 2. Derive the public key from the unwrapped private and compare.
  try {
    const derivedPub = s.crypto_scalarmult_base(priv);
    const storedPub = s.from_base64(publicKeyB64, s.base64_variants.ORIGINAL);
    const equal =
      derivedPub.length === storedPub.length &&
      derivedPub.every((b, i) => b === storedPub[i]);
    checks.public_key_matches = equal ? "ok" : "mismatch";
    if (!equal) {
      return { ok: false, publicKey: publicKeyB64, checks };
    }
  } catch (err) {
    checks.public_key_matches = "error";
    return {
      ok: false,
      publicKey: publicKeyB64,
      checks,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 3. Full round-trip: encrypt a probe to yourself and decrypt it back.
  try {
    const probe = `verify:${Date.now()}:${s.to_hex(s.randombytes_buf(8))}`;
    const enc = await encryptNote(probe, [
      { user_id: "self", public_key: publicKeyB64 },
    ]);
    const wrapped = enc.wrapped_keys[0]?.wrapped_key;
    if (!wrapped) throw new Error("No wrapped key produced");
    const decrypted = await decryptNote(
      {
        body_ciphertext: enc.body_ciphertext,
        body_nonce: enc.body_nonce,
        wrapped_key: wrapped,
      },
      { publicKey: publicKeyB64, privateKey: priv },
    );
    checks.round_trip_encrypt_decrypt = decrypted === probe ? "ok" : "failed";
    if (decrypted !== probe) {
      return { ok: false, publicKey: publicKeyB64, checks };
    }
  } catch (err) {
    checks.round_trip_encrypt_decrypt = "error";
    return {
      ok: false,
      publicKey: publicKeyB64,
      checks,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return { ok: true, publicKey: publicKeyB64, checks };
}
