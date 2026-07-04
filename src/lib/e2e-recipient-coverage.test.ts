import { describe, it, expect } from "vitest";
import { evaluateRecipientCoverage } from "./e2e-recipient-coverage";

/**
 * Fixture models a small clinic:
 *   author  — posting the note (must never appear as a "teammate")
 *   alice   — enrolled clinician (has key)
 *   bob     — enrolled clinician (has key)
 *   carol   — clinician who NEVER enrolled (no key)
 *   dave    — clinician who was enrolled but rotated/removed their key
 *   erin    — enrolled clinician who just published a key between the
 *             last client check and this submission
 */
const U = {
  author: "00000000-0000-0000-0000-000000000001",
  alice:  "00000000-0000-0000-0000-000000000002",
  bob:    "00000000-0000-0000-0000-000000000003",
  carol:  "00000000-0000-0000-0000-000000000004",
  dave:   "00000000-0000-0000-0000-000000000005",
  erin:   "00000000-0000-0000-0000-000000000006",
};

const CLINICIANS = [U.author, U.alice, U.bob, U.carol, U.dave, U.erin];

describe("evaluateRecipientCoverage — rules enforced by addEncryptedNote", () => {
  it("passes when every clinician has a key and is in the recipient set", () => {
    const verdict = evaluateRecipientCoverage({
      authorId: U.author,
      clinicianIds: CLINICIANS,
      enrolledIds: [U.author, U.alice, U.bob, U.carol, U.dave, U.erin],
      requestedRecipientIds: [U.author, U.alice, U.bob, U.carol, U.dave, U.erin],
      allowReducedRecipients: false,
    });
    expect(verdict.ok).toBe(true);
  });

  it("rejects when a clinician has no published key and opt-in is false", () => {
    // Carol has no key.
    const verdict = evaluateRecipientCoverage({
      authorId: U.author,
      clinicianIds: CLINICIANS,
      enrolledIds: [U.author, U.alice, U.bob, U.dave, U.erin],
      requestedRecipientIds: [U.author, U.alice, U.bob, U.dave, U.erin],
      allowReducedRecipients: false,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.missingNoKey).toEqual([U.carol]);
    expect(verdict.enrolledButExcluded).toEqual([]);
    expect(verdict.strayRecipients).toEqual([]);
  });

  it("rejects when a newly-enrolled teammate is missing from wrapped_keys", () => {
    // Erin just enrolled server-side but the client didn't include her key.
    const verdict = evaluateRecipientCoverage({
      authorId: U.author,
      clinicianIds: CLINICIANS,
      enrolledIds: [U.author, U.alice, U.bob, U.dave, U.erin],
      requestedRecipientIds: [U.author, U.alice, U.bob, U.dave],
      allowReducedRecipients: false,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.enrolledButExcluded).toEqual([U.erin]);
    // Carol still has no key — surfaces in the same rejection.
    expect(verdict.missingNoKey).toEqual([U.carol]);
    expect(verdict.strayRecipients).toEqual([]);
  });

  it("rejects a stale recipient whose key was rotated away, even with opt-in", () => {
    // Dave's key was removed. The client still sent a wrapped key for him.
    const verdict = evaluateRecipientCoverage({
      authorId: U.author,
      clinicianIds: CLINICIANS,
      enrolledIds: [U.author, U.alice, U.bob, U.erin], // dave dropped
      requestedRecipientIds: [U.author, U.alice, U.bob, U.dave, U.erin],
      allowReducedRecipients: true, // opt-in does NOT rescue stray recipients
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.strayRecipients).toEqual([U.dave]);
    // With opt-in, the other buckets are suppressed — they represent the
    // reduced set the author already accepted.
    expect(verdict.missingNoKey).toEqual([]);
    expect(verdict.enrolledButExcluded).toEqual([]);
  });

  it("allows posting to a reduced set when allow_reduced_recipients is true", () => {
    // Author knowingly posts to only alice + bob, even though carol has no
    // key and dave/erin are deselected but enrolled.
    const verdict = evaluateRecipientCoverage({
      authorId: U.author,
      clinicianIds: CLINICIANS,
      enrolledIds: [U.author, U.alice, U.bob, U.dave, U.erin],
      requestedRecipientIds: [U.author, U.alice, U.bob],
      allowReducedRecipients: true,
    });
    expect(verdict.ok).toBe(true);
  });

  it("rejects the same reduced set when the opt-in flag is missing", () => {
    const verdict = evaluateRecipientCoverage({
      authorId: U.author,
      clinicianIds: CLINICIANS,
      enrolledIds: [U.author, U.alice, U.bob, U.dave, U.erin],
      requestedRecipientIds: [U.author, U.alice, U.bob],
      allowReducedRecipients: false,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.missingNoKey).toEqual([U.carol]);
    expect(verdict.enrolledButExcluded.sort()).toEqual([U.dave, U.erin].sort());
    expect(verdict.strayRecipients).toEqual([]);
  });

  it("does not treat the author as a teammate for coverage checks", () => {
    // Author's own id is intentionally omitted from the recipient set.
    // Since the author is not a "teammate", this must not trigger a
    // missing/excluded rejection.
    const verdict = evaluateRecipientCoverage({
      authorId: U.author,
      clinicianIds: [U.author, U.alice],
      enrolledIds: [U.author, U.alice],
      requestedRecipientIds: [U.alice],
      allowReducedRecipients: false,
    });
    expect(verdict.ok).toBe(true);
  });

  it("does not flag the author as a stray recipient when unenrolled", () => {
    // Author is not enrolled themselves (edge case), but is in their own
    // wrapped_keys. The author is excluded from stray-recipient checks.
    const verdict = evaluateRecipientCoverage({
      authorId: U.author,
      clinicianIds: [U.author, U.alice],
      enrolledIds: [U.alice],
      requestedRecipientIds: [U.author, U.alice],
      allowReducedRecipients: false,
    });
    expect(verdict.ok).toBe(true);
  });
});
