import { describe, it, expect } from "vitest";
import { redactAuditDiff } from "./audit-redact";

describe("redactAuditDiff", () => {
  it("drops keys with crypto suffixes (_enc, _ciphertext, _nonce, _hash)", () => {
    const out = redactAuditDiff({
      hospital_number_enc: "v1:AAAA…",
      hospital_number_hash: "abcd1234",
      body_ciphertext: "…",
      body_nonce: "…",
      status: "pending",
    });
    expect(out).toEqual({ status: "pending" });
  });

  it("replaces known-sensitive plaintext values with [encrypted]", () => {
    const out = redactAuditDiff({
      hospital_number: "H12345",
      reason_for_referral: "Sepsis, requires ITU",
      past_medical_history: "COPD, HTN",
      status: "accepted",
    });
    expect(out).toEqual({
      hospital_number: "[encrypted]",
      reason_for_referral: "[encrypted]",
      past_medical_history: "[encrypted]",
      status: "accepted",
    });
  });

  it("redacts both branches of an { old, new } diff, preserving nulls", () => {
    const out = redactAuditDiff({
      reason_for_referral: { old: "prev reason", new: "new reason" },
      past_medical_history: { old: null, new: "COPD" },
      status: { old: "pending", new: "accepted" },
    });
    expect(out).toEqual({
      reason_for_referral: { old: "[encrypted]", new: "[encrypted]" },
      past_medical_history: { old: null, new: "[encrypted]" },
      status: { old: "pending", new: "accepted" },
    });
  });

  it("recurses into nested objects and arrays", () => {
    const out = redactAuditDiff({
      changes: [
        { hospital_number_enc: "x", note: "safe" },
        { body: "secret note body" },
      ],
      wrapper: { patient_initials: "AB", meta: { deleted: false } },
    });
    expect(out).toEqual({
      changes: [{ note: "safe" }, { body: "[encrypted]" }],
      wrapper: { patient_initials: "[encrypted]", meta: { deleted: false } },
    });
  });

  it("passes through null / primitive diffs unchanged", () => {
    expect(redactAuditDiff(null)).toBeNull();
    expect(redactAuditDiff(42)).toBe(42);
    expect(redactAuditDiff("ok")).toBe("ok");
  });

  // Regression guard: the redactor must remain suffix-driven, not
  // allowlist-driven, for crypto columns. Any future encrypted column
  // added to the schema — long after this test was written — should be
  // dropped automatically as long as it follows the `*_enc`,
  // `*_ciphertext`, `*_nonce`, or `*_hash` naming convention. If someone
  // rewrites the redactor around a fixed list of known columns, this
  // test fails and forces them to preserve the fallback.
  it("drops NEW encrypted columns not in any allowlist, purely by crypto suffix", () => {
    const out = redactAuditDiff({
      // Fabricated columns that don't exist today; they must still be
      // stripped because their names end in a crypto suffix.
      future_column_enc: "v2:ZZZZ…",
      brand_new_field_ciphertext: "…lots of base64…",
      unseen_thing_nonce: "IV-BYTES",
      totally_unknown_hash: "sha256:deadbeef",
      // Nested inside an { old, new } diff — both branches must lose
      // the suffix keys too.
      diff: {
        old: { experimental_secret_enc: "OLD", other: "keep" },
        new: { experimental_secret_enc: "NEW", other: "keep2" },
      },
      // Inside an array — same rule.
      history: [
        { unmapped_pii_hash: "abc", label: "row1" },
        { some_new_col_nonce: "xyz", label: "row2" },
      ],
      // Untouched key stays as-is.
      status: "pending",
    });

    expect(out).toEqual({
      diff: {
        old: { other: "keep" },
        new: { other: "keep2" },
      },
      history: [{ label: "row1" }, { label: "row2" }],
      status: "pending",
    });
  });

  it("passes through null / primitive diffs unchanged", () => {
    expect(redactAuditDiff(null)).toBeNull();
    expect(redactAuditDiff(42)).toBe(42);
    expect(redactAuditDiff("ok")).toBe("ok");
  });
});

