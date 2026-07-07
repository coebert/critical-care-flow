import { describe, it, expect } from "vitest";
import {
  canTransition,
  nextAllowedStatuses,
  isEligibleForConversion,
} from "./postop-lifecycle";

describe("postop lifecycle transitions", () => {
  const ok = {
    preop_signed_off_at: "2026-07-07T09:00:00Z",
    intensivist_reviewed_at: "2026-07-07T09:30:00Z",
  };

  it("allows requested → provisional", () => {
    expect(canTransition("requested", "provisionally_confirmed", ok).ok).toBe(true);
  });

  it("blocks requested → confirmed without sign-offs", () => {
    const d = canTransition("requested", "confirmed", {
      preop_signed_off_at: null,
      intensivist_reviewed_at: null,
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/sign-off/i);
  });

  it("allows requested → confirmed with sign-offs", () => {
    expect(canTransition("requested", "confirmed", ok).ok).toBe(true);
  });

  it("requires a cancellation reason", () => {
    const d = canTransition("confirmed", "cancelled", ok);
    expect(d.ok).toBe(false);
    const d2 = canTransition("confirmed", "cancelled", { ...ok, cancellation_reason: "no_bed" });
    expect(d2.ok).toBe(true);
  });

  it("cannot leave admitted state", () => {
    expect(canTransition("admitted", "cancelled", ok).ok).toBe(false);
    expect(nextAllowedStatuses("admitted")).toEqual([]);
  });

  it("cannot leave cancelled state", () => {
    expect(nextAllowedStatuses("cancelled")).toEqual([]);
  });

  it("rejects same-state transition", () => {
    expect(canTransition("requested", "requested", ok).ok).toBe(false);
  });
});

describe("isEligibleForConversion", () => {
  const today = new Date("2026-07-07T10:00:00Z");

  it("blocks bookings not confirmed", () => {
    expect(
      isEligibleForConversion(
        {
          booking_status: "requested",
          proposed_surgery_date: "2026-07-07",
          converted_referral_id: null,
        },
        today,
      ),
    ).toBe(false);
  });

  it("allows confirmed today", () => {
    expect(
      isEligibleForConversion(
        {
          booking_status: "confirmed",
          proposed_surgery_date: "2026-07-07",
          converted_referral_id: null,
        },
        today,
      ),
    ).toBe(true);
  });

  it("blocks already-converted", () => {
    expect(
      isEligibleForConversion(
        {
          booking_status: "confirmed",
          proposed_surgery_date: "2026-07-07",
          converted_referral_id: "ref-1",
        },
        today,
      ),
    ).toBe(false);
  });

  it("blocks future surgery dates", () => {
    expect(
      isEligibleForConversion(
        {
          booking_status: "confirmed",
          proposed_surgery_date: "2026-07-20",
          converted_referral_id: null,
        },
        today,
      ),
    ).toBe(false);
  });

  it("blocks soft-deleted bookings", () => {
    expect(
      isEligibleForConversion(
        {
          booking_status: "confirmed",
          proposed_surgery_date: "2026-07-07",
          converted_referral_id: null,
          deleted_at: "2026-07-06T00:00:00Z",
        },
        today,
      ),
    ).toBe(false);
  });
});
