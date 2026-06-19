import { describe, it, expect } from "vitest";
import { validateReferralTimings, type ReferralTimingInput } from "./referral-validation";

const iso = (offsetMin: number) =>
  new Date(Date.now() + offsetMin * 60_000).toISOString();

const base = (overrides: Partial<ReferralTimingInput> = {}): ReferralTimingInput => ({
  status: "pending",
  referral_received_at: iso(-60),
  first_seen_at: null,
  decision_at: null,
  arrived_on_unit_at: null,
  ...overrides,
});

describe("validateReferralTimings — required fields", () => {
  it("requires referral_received_at on every record", () => {
    const r = validateReferralTimings(base({ referral_received_at: null }));
    expect(r.isValid).toBe(false);
    expect(r.fieldErrors.referral_received_at).toBeDefined();
  });

  it("pending status only requires received", () => {
    const r = validateReferralTimings(base());
    expect(r.isValid).toBe(true);
    expect(r.fieldErrors).toEqual({});
  });

  it("admitted requires first_seen, decision, and arrived", () => {
    const r = validateReferralTimings(base({ status: "admitted" }));
    expect(r.isValid).toBe(false);
    expect(r.fieldErrors.first_seen_at).toBeDefined();
    expect(r.fieldErrors.decision_at).toBeDefined();
    expect(r.fieldErrors.arrived_on_unit_at).toBeDefined();
  });

  it("declined requires first_seen and decision but not arrived", () => {
    const r = validateReferralTimings(
      base({
        status: "declined",
        first_seen_at: iso(-50),
        decision_at: iso(-40),
      }),
    );
    expect(r.isValid).toBe(true);
  });

  it("declined must not have an arrival time", () => {
    const r = validateReferralTimings(
      base({
        status: "declined",
        first_seen_at: iso(-50),
        decision_at: iso(-40),
        arrived_on_unit_at: iso(-30),
      }),
    );
    expect(r.isValid).toBe(false);
    expect(r.fieldErrors.arrived_on_unit_at).toMatch(/should not/i);
  });

  it("admitted with full chronological timestamps is valid", () => {
    const r = validateReferralTimings({
      status: "admitted",
      referral_received_at: iso(-60),
      first_seen_at: iso(-45),
      decision_at: iso(-30),
      arrived_on_unit_at: iso(-15),
    });
    expect(r.isValid).toBe(true);
  });
});

describe("validateReferralTimings — future timestamps", () => {
  it("rejects received in the future", () => {
    const r = validateReferralTimings(base({ referral_received_at: iso(60) }));
    expect(r.fieldErrors.referral_received_at).toMatch(/future/i);
  });

  it("rejects first_seen in the future", () => {
    const r = validateReferralTimings(
      base({
        status: "admitted",
        first_seen_at: iso(120),
        decision_at: iso(130),
        arrived_on_unit_at: iso(140),
      }),
    );
    expect(r.fieldErrors.first_seen_at).toMatch(/future/i);
  });

  it("rejects decision in the future", () => {
    const r = validateReferralTimings(
      base({
        status: "declined",
        first_seen_at: iso(-10),
        decision_at: iso(120),
      }),
    );
    expect(r.fieldErrors.decision_at).toMatch(/future/i);
  });

  it("rejects arrived in the future", () => {
    const r = validateReferralTimings(
      base({
        status: "admitted",
        first_seen_at: iso(-30),
        decision_at: iso(-20),
        arrived_on_unit_at: iso(120),
      }),
    );
    expect(r.fieldErrors.arrived_on_unit_at).toMatch(/future/i);
  });

  it("allows small (≤2 min) clock skew", () => {
    const r = validateReferralTimings(base({ referral_received_at: iso(1) }));
    expect(r.fieldErrors.referral_received_at).toBeUndefined();
  });
});

describe("validateReferralTimings — out-of-order timestamps", () => {
  it("flags first_seen before received", () => {
    const r = validateReferralTimings(
      base({
        status: "declined",
        referral_received_at: iso(-30),
        first_seen_at: iso(-60),
        decision_at: iso(-20),
      }),
    );
    expect(r.isValid).toBe(false);
    expect(r.fieldErrors.first_seen_at).toBeDefined();
    expect(r.issues).toContain("Patient was 'first seen' before the referral was received.");
  });

  it("flags decision before first_seen", () => {
    const r = validateReferralTimings(
      base({
        status: "declined",
        referral_received_at: iso(-60),
        first_seen_at: iso(-30),
        decision_at: iso(-45),
      }),
    );
    expect(r.isValid).toBe(false);
    expect(r.fieldErrors.decision_at).toBeDefined();
    expect(r.issues.some((i) => /Decision .* before .* first seen/i.test(i))).toBe(true);
  });

  it("flags decision before received when first_seen is absent", () => {
    const r = validateReferralTimings({
      status: "declined",
      referral_received_at: iso(-30),
      first_seen_at: null,
      decision_at: iso(-60),
      arrived_on_unit_at: null,
    });
    // first_seen also required for non-pending, but the ordering issue must still appear
    expect(r.issues.some((i) => /Decision .* before .* referral was received/i.test(i))).toBe(true);
  });

  it("flags arrival before decision", () => {
    const r = validateReferralTimings({
      status: "admitted",
      referral_received_at: iso(-60),
      first_seen_at: iso(-45),
      decision_at: iso(-20),
      arrived_on_unit_at: iso(-30),
    });
    expect(r.isValid).toBe(false);
    expect(r.fieldErrors.arrived_on_unit_at).toBeDefined();
    expect(r.issues.some((i) => /arrived .* before .* decision/i.test(i))).toBe(true);
  });

  it("flags multiple ordering issues at once", () => {
    const r = validateReferralTimings({
      status: "admitted",
      referral_received_at: iso(-30),
      first_seen_at: iso(-60),
      decision_at: iso(-50),
      arrived_on_unit_at: iso(-55),
    });
    expect(r.isValid).toBe(false);
    expect(r.issues.length).toBeGreaterThanOrEqual(2);
  });
});

describe("validateReferralTimings — malformed input", () => {
  it("treats unparsable date strings as missing", () => {
    const r = validateReferralTimings(base({ referral_received_at: "not-a-date" }));
    expect(r.fieldErrors.referral_received_at).toMatch(/required/i);
  });
});
