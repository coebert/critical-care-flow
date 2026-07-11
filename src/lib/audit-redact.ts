/**
 * Redact sensitive patient data from audit-log `diff` payloads before they
 * leave the server. Applied by `getAuditLog` so the Audit tab never
 * receives ciphertext, hashes, nonces, or plaintext of encrypted columns —
 * even if an old audit row was written before we standardised redaction.
 *
 * Rules (applied recursively to nested objects/arrays):
 *   - Any key whose name ends in one of the crypto suffixes
 *     (`_enc`, `_ciphertext`, `_nonce`, `_hash`) is DROPPED entirely.
 *     These are noise — they are not human-readable and their presence
 *     alone can leak information (e.g. row length, deterministic hash).
 *   - Any key matching a known-sensitive plaintext column (hospital
 *     number, PMH, PSH, social history, baseline function, reason for
 *     referral, reason for bed, proposed procedure, note body,
 *     patient initials, DNACPR details) has its value replaced with the
 *     literal string `"[encrypted]"`. This preserves the shape of the
 *     diff (so the UI can still show "field X changed") without leaking
 *     the value. Old-shape `{ old, new }` diffs are handled — both
 *     branches are redacted.
 */

const CRYPTO_SUFFIXES = ["_enc", "_ciphertext", "_nonce", "_hash"] as const;

// Plaintext columns whose values are considered sensitive patient data.
// Keep in sync with the `*_enc` columns in the referrals / notes schema
// and any free-text clinical fields whose plaintext should never appear
// in the audit tab.
const SENSITIVE_PLAINTEXT_KEYS = new Set<string>([
  "hospital_number",
  "patient_initials",
  "reason_for_referral",
  "reason_for_bed",
  "past_medical_history",
  "past_surgical_history",
  "social_history",
  "baseline_function",
  "proposed_procedure",
  "body", // referral_notes.body plaintext
  "dnacpr_details",
  "dnacpr_reason",
  "tep_details",
  "allergies",
  "infection_organism",
]);

const REDACTED = "[encrypted]" as const;

function hasCryptoSuffix(key: string): boolean {
  return CRYPTO_SUFFIXES.some((s) => key.endsWith(s));
}

export function redactAuditDiff(input: unknown): unknown {
  if (input == null) return input;
  if (Array.isArray(input)) return input.map((v) => redactAuditDiff(v));
  if (typeof input !== "object") return input;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    // Drop ciphertext/hash/nonce keys entirely.
    if (hasCryptoSuffix(key)) continue;

    // Redact plaintext value for known-sensitive columns, recursing into
    // `{ old, new }` diffs so both branches are hidden.
    if (SENSITIVE_PLAINTEXT_KEYS.has(key)) {
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        ("old" in (value as object) || "new" in (value as object))
      ) {
        const v = value as { old?: unknown; new?: unknown };
        out[key] = {
          ...("old" in v ? { old: v.old == null ? v.old : REDACTED } : {}),
          ...("new" in v ? { new: v.new == null ? v.new : REDACTED } : {}),
        };
      } else if (value == null) {
        out[key] = value;
      } else {
        out[key] = REDACTED;
      }
      continue;
    }

    // Recurse into nested structures.
    out[key] = redactAuditDiff(value);
  }
  return out;
}
