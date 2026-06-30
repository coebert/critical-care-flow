// Server-only application-layer encryption helpers.
//
// All sensitive free-text fields are encrypted here BEFORE leaving the
// server, so the database only ever sees ciphertext. The symmetric key
// and HMAC key live in the server environment (APP_ENCRYPTION_KEY,
// APP_HMAC_KEY) and are never written to the database. A leak of the
// database alone is therefore unreadable.
//
// Format for encrypted values:
//   "v1:" + base64( iv(12) || authTag(16) || ciphertext )
//
// Format for the hospital-number hash:
//   hex( HMAC_SHA256(APP_HMAC_KEY, normalized hospital number) )

import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes } from "crypto";

const VERSION = "v1";

function deriveKey(envName: string): Buffer {
  const raw = process.env[envName];
  if (!raw) throw new Error(`${envName} is not configured`);
  // Accept any-length secret; derive a stable 32-byte key.
  return createHash("sha256").update(raw, "utf8").digest();
}

let _encKey: Buffer | null = null;
let _hmacKey: Buffer | null = null;
function encKey(): Buffer {
  if (!_encKey) _encKey = deriveKey("APP_ENCRYPTION_KEY");
  return _encKey;
}
function hmacKey(): Buffer {
  if (!_hmacKey) _hmacKey = deriveKey("APP_HMAC_KEY");
  return _hmacKey;
}

/**
 * Encrypt a UTF-8 string. Returns null for null/empty input so empty
 * fields don't take up space and stay queryable as IS NULL.
 */
export function encryptString(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined) return null;
  const s = String(plain);
  if (s.length === 0) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey(), iv);
  const ct = Buffer.concat([cipher.update(s, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${Buffer.concat([iv, tag, ct]).toString("base64")}`;
}

/**
 * Decrypt a value produced by encryptString. Returns null for null
 * input. Throws on tampering (GCM auth-tag mismatch) so corrupted rows
 * are loud rather than silently wrong.
 */
export function decryptString(payload: string | null | undefined): string | null {
  if (payload === null || payload === undefined || payload === "") return null;
  const [ver, b64] = payload.split(":", 2);
  if (ver !== VERSION || !b64) {
    throw new Error("Unsupported ciphertext format");
  }
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 12 + 16 + 1) throw new Error("Ciphertext too short");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", encKey(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

/**
 * Deterministic hash of a hospital number so we can still look up
 * repeat referrals without storing the plaintext. Case- and
 * whitespace-insensitive. Returns null for empty input.
 */
export function hashHospitalNumber(hn: string | null | undefined): string | null {
  if (!hn) return null;
  const norm = String(hn).trim().toLowerCase();
  if (!norm) return null;
  return createHmac("sha256", hmacKey()).update(norm, "utf8").digest("hex");
}
