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
});
