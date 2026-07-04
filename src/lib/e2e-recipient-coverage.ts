/**
 * Pure recipient-coverage evaluator used by the addEncryptedNote server
 * function.  Kept dependency-free so it can be exercised by unit tests
 * without a Supabase client.
 *
 * The rules mirror what the compose UI enforces on the client, but are
 * re-evaluated on the server against the live key directory so a race
 * between the last client check and submission cannot silently:
 *
 *   1. exclude a teammate who just enrolled          → enrolled_but_excluded
 *   2. post to a teammate whose key was rotated away → stray_recipients
 *   3. include no wrapped key for a clinician who never enrolled
 *      (only surfaces when the author has NOT opted into a reduced set)
 *                                                     → missing_no_key
 */
export type CoverageInput = {
  authorId: string;
  /** All clinician + admin user IDs known to the system (author included). */
  clinicianIds: Iterable<string>;
  /** User IDs that currently have a published public key. */
  enrolledIds: Iterable<string>;
  /** recipient_user_ids from the submitted wrapped_keys array. */
  requestedRecipientIds: Iterable<string>;
  /** Client's explicit "post to reduced recipient set" opt-in. */
  allowReducedRecipients: boolean;
};

export type CoverageResult =
  | { ok: true }
  | {
      ok: false;
      reason: "recipient_coverage_changed";
      missingNoKey: string[];
      enrolledButExcluded: string[];
      strayRecipients: string[];
    };

export function evaluateRecipientCoverage(input: CoverageInput): CoverageResult {
  const clinicians = new Set(input.clinicianIds);
  const enrolled = new Set(input.enrolledIds);
  const requested = new Set(input.requestedRecipientIds);

  // Author is not a "teammate" for coverage purposes.
  clinicians.delete(input.authorId);

  const missingNoKey: string[] = [];
  const enrolledButExcluded: string[] = [];
  for (const cid of clinicians) {
    if (requested.has(cid)) continue;
    if (enrolled.has(cid)) enrolledButExcluded.push(cid);
    else missingNoKey.push(cid);
  }

  // Any recipient we were asked to wrap for who no longer has a published
  // key. These rows would either fail the FK check or store an unusable
  // ciphertext, so they are ALWAYS rejected — the opt-in flag does not
  // rescue them.
  const strayRecipients = Array.from(requested).filter(
    (rid) => rid !== input.authorId && !enrolled.has(rid),
  );

  if (strayRecipients.length > 0) {
    return {
      ok: false,
      reason: "recipient_coverage_changed",
      // When the caller opted into a reduced set, only surface the strays;
      // the other buckets are the "reduced set" they explicitly accepted.
      missingNoKey: input.allowReducedRecipients ? [] : missingNoKey,
      enrolledButExcluded: input.allowReducedRecipients ? [] : enrolledButExcluded,
      strayRecipients,
    };
  }

  if (input.allowReducedRecipients) return { ok: true };

  if (missingNoKey.length > 0 || enrolledButExcluded.length > 0) {
    return {
      ok: false,
      reason: "recipient_coverage_changed",
      missingNoKey,
      enrolledButExcluded,
      strayRecipients: [],
    };
  }

  return { ok: true };
}
