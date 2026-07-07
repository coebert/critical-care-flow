import { describe, it, expect } from "vitest";
import { deriveOutcomeFromLegacyStatus, validateReferralOutcome } from "./referral-outcome";

describe("deriveOutcomeFromLegacyStatus", () => {
  it("maps legacy status to outcome", () => {
    expect(deriveOutcomeFromLegacyStatus("accepted")).toBe("admit_for_admission");
    expect(deriveOutcomeFromLegacyStatus("admitted")).toBe("admit_for_admission");
    expect(deriveOutcomeFromLegacyStatus("declined")).toBe("declined");
    expect(deriveOutcomeFromLegacyStatus("pending")).toBeNull();
    expect(deriveOutcomeFromLegacyStatus(null)).toBeNull();
  });
});

const baseInputs = {
  outcome: null,
  ceiling_of_care: null,
  reason_notes: null,
  decline_reason: null,
  discussed_with_consultant: null,
  accepting_consultant: null,
  first_seen_at: null,
} as const;

describe("validateReferralOutcome", () => {
  it("no outcome = no required-field errors", () => {
    const r = validateReferralOutcome({ ...baseInputs });
    expect(r.isValid).toBe(true);
  });

  it("any outcome requires ceiling of care", () => {
    const r = validateReferralOutcome({
      ...baseInputs,
      outcome: "advice_given",
      discussed_with_consultant: "Dr Smith",
      reason_notes: "Advised NIV",
    });
    expect(r.isValid).toBe(false);
    expect(r.fieldErrors.ceiling_of_care).toBeDefined();
  });

  it("admit outcome requires accepting_consultant", () => {
    const r = validateReferralOutcome({
      ...baseInputs,
      outcome: "admit_for_admission",
      ceiling_of_care: "full_escalation",
    });
    expect(r.fieldErrors.accepting_consultant).toBeDefined();
  });

  it("review_on_ward requires first_seen_at", () => {
    const r = validateReferralOutcome({
      ...baseInputs,
      outcome: "review_on_ward",
      ceiling_of_care: "full_escalation",
    });
    expect(r.fieldErrors.first_seen_at).toBeDefined();
  });

  it("advice_given requires discussed_with_consultant and reason_notes", () => {
    const r = validateReferralOutcome({
      ...baseInputs,
      outcome: "advice_given",
      ceiling_of_care: "ward_based",
    });
    expect(r.fieldErrors.discussed_with_consultant).toBeDefined();
    expect(r.fieldErrors.reason_notes).toBeDefined();
  });

  it("declined requires decline_reason and discussed_with_consultant", () => {
    const r = validateReferralOutcome({
      ...baseInputs,
      outcome: "declined",
      ceiling_of_care: "ward_based",
    });
    expect(r.fieldErrors.decline_reason).toBeDefined();
    expect(r.fieldErrors.discussed_with_consultant).toBeDefined();
  });

  it("declined with full context is valid", () => {
    const r = validateReferralOutcome({
      ...baseInputs,
      outcome: "declined",
      ceiling_of_care: "ward_based",
      decline_reason: "Ward-based ceiling of care",
      discussed_with_consultant: "Dr Smith",
    });
    expect(r.isValid).toBe(true);
  });
});
