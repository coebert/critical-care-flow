import { describe, it, expect } from "vitest";
import {
  validateReferralAll,
  validateReferralDecisionFields,
  type ReferralFieldInput,
} from "./referral-validation";

const iso = (offsetMin: number) =>
  new Date(Date.now() + offsetMin * 60_000).toISOString();

const complete = (overrides: Partial<ReferralFieldInput> = {}): ReferralFieldInput => ({
  status: "admitted",
  referral_received_at: iso(-60),
  first_seen_at: iso(-45),
  decision_at: iso(-30),
  arrived_on_unit_at: iso(-15),
  decline_reason: null,
  discussed_with_consultant: null,
  accepting_consultant: "Dr Smith",
  admission_urgency: "within_1_hour",
  ...overrides,
});

describe("validateReferralDecisionFields — required fields", () => {
  it("declined without a reason is invalid", () => {
    const r = validateReferralDecisionFields({
      status: "declined",
      decline_reason: "",
      discussed_with_consultant: "Dr Grey",
    });
    expect(r.isValid).toBe(false);
    expect(r.fieldErrors.decline_reason).toMatch(/reason/i);
  });

  it("declined without a discussed-with consultant is invalid", () => {
    const r = validateReferralDecisionFields({
      status: "declined",
      decline_reason: "No ICU bed",
      discussed_with_consultant: "",
    });
    expect(r.fieldErrors.discussed_with_consultant).toBeDefined();
  });

  it("accepted without an accepting consultant is invalid", () => {
    const r = validateReferralDecisionFields({
      status: "accepted",
      accepting_consultant: "",
    });
    expect(r.fieldErrors.accepting_consultant).toBeDefined();
  });

  it("admitted without an admission urgency is invalid", () => {
    const r = validateReferralDecisionFields({
      status: "admitted",
      accepting_consultant: "Dr Smith",
      admission_urgency: "",
    });
    expect(r.fieldErrors.admission_urgency).toMatch(/urgency/i);
  });

  it("admitted with admission_urgency=not_admitting is invalid", () => {
    const r = validateReferralDecisionFields({
      status: "admitted",
      accepting_consultant: "Dr Smith",
      admission_urgency: "not_admitting",
    });
    expect(r.fieldErrors.admission_urgency).toBeDefined();
  });
});

describe("validateReferralDecisionFields — logical consistency", () => {
  it("declined must not have an accepting consultant", () => {
    const r = validateReferralDecisionFields({
      status: "declined",
      decline_reason: "No bed",
      discussed_with_consultant: "Dr Grey",
      accepting_consultant: "Dr Smith",
    });
    expect(r.fieldErrors.accepting_consultant).toBeDefined();
    expect(r.issues.some((i) => /accepting consultant/i.test(i))).toBe(true);
  });

  it("declined must not have a live admission urgency", () => {
    const r = validateReferralDecisionFields({
      status: "declined",
      decline_reason: "No bed",
      discussed_with_consultant: "Dr Grey",
      admission_urgency: "within_1_hour",
    });
    expect(r.fieldErrors.admission_urgency).toBeDefined();
  });

  it("accepted must not carry a decline reason", () => {
    const r = validateReferralDecisionFields({
      status: "accepted",
      accepting_consultant: "Dr Smith",
      decline_reason: "Reconsider later",
    });
    expect(r.fieldErrors.decline_reason).toBeDefined();
  });

  it("pending must not carry decline reason or accepting consultant", () => {
    const r = validateReferralDecisionFields({
      status: "pending",
      decline_reason: "text",
      accepting_consultant: "Dr Smith",
    });
    expect(r.fieldErrors.decline_reason).toBeDefined();
    expect(r.fieldErrors.accepting_consultant).toBeDefined();
  });

  it("fully consistent admitted record validates", () => {
    const r = validateReferralDecisionFields({
      status: "admitted",
      accepting_consultant: "Dr Smith",
      admission_urgency: "within_1_hour",
    });
    expect(r.isValid).toBe(true);
  });
});

describe("validateReferralAll — combined timings + decision fields", () => {
  it("complete admitted referral validates", () => {
    const r = validateReferralAll(complete());
    expect(r.isValid).toBe(true);
  });

  it("aggregates missing timing and missing decision fields", () => {
    const r = validateReferralAll(
      complete({
        arrived_on_unit_at: null,
        accepting_consultant: "",
        admission_urgency: null,
      }),
    );
    expect(r.isValid).toBe(false);
    expect(r.fieldErrors.arrived_on_unit_at).toBeDefined();
    expect(r.fieldErrors.accepting_consultant).toBeDefined();
    expect(r.fieldErrors.admission_urgency).toBeDefined();
  });

  it("declined referral with arrival AND missing reason surfaces both errors", () => {
    const r = validateReferralAll(
      complete({
        status: "declined",
        arrived_on_unit_at: iso(-10),
        accepting_consultant: null,
        admission_urgency: null,
        decline_reason: "",
        discussed_with_consultant: "",
      }),
    );
    expect(r.isValid).toBe(false);
    expect(r.fieldErrors.arrived_on_unit_at).toMatch(/should not/i);
    expect(r.fieldErrors.decline_reason).toBeDefined();
    expect(r.fieldErrors.discussed_with_consultant).toBeDefined();
  });

  it("ignorePastCap lets an old referral be re-saved on update", () => {
    const veryOld = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const strict = validateReferralAll(
      complete({
        referral_received_at: veryOld,
        first_seen_at: veryOld,
        decision_at: veryOld,
        arrived_on_unit_at: veryOld,
      }),
    );
    expect(strict.fieldErrors.referral_received_at).toMatch(/days ago/i);

    const lenient = validateReferralAll(
      complete({
        referral_received_at: veryOld,
        first_seen_at: veryOld,
        decision_at: veryOld,
        arrived_on_unit_at: veryOld,
      }),
      { ignorePastCap: true },
    );
    expect(lenient.isValid).toBe(true);
  });
});
