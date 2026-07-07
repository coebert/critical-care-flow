import { describe, it, expect } from "vitest";
import { applyQuickFilter, matchesQuickFilter } from "./quick-filters";
import type { Referral } from "./referrals-list-utils";

const base = {
  id: "0",
  referral_received_at: "2026-01-01T00:00:00Z",
} as unknown as Referral;

function make(overrides: Partial<Referral>): Referral {
  return { ...base, ...overrides } as Referral;
}

describe("quick-filters", () => {
  const rows: Referral[] = [
    make({ id: "a", status: "pending", outcome: null, arrived_on_unit_at: null } as Partial<Referral>),
    make({ id: "b", status: "pending", outcome: "admit_for_admission" } as Partial<Referral>),
    make({ id: "c", status: "accepted", outcome: "admit_for_admission", arrived_on_unit_at: null } as Partial<Referral>),
    make({ id: "d", status: "accepted", outcome: "admit_for_admission", arrived_on_unit_at: "2026-01-01T00:00:00Z" } as Partial<Referral>),
    make({ id: "e", status: "admitted", outcome: "admit_for_admission" } as Partial<Referral>),
    make({ id: "f", status: "pending", outcome: null, discussed_with_consultant: "Dr Smith" } as Partial<Referral>),
  ];

  it("all returns everything", () => {
    expect(applyQuickFilter(rows, "all")).toHaveLength(6);
  });
  it("awaiting_review = pending + no outcome", () => {
    const ids = applyQuickFilter(rows, "awaiting_review").map((r) => r.id);
    expect(ids.sort()).toEqual(["a", "f"]);
  });
  it("awaiting_bed = accepted-for-admission but not yet admitted", () => {
    const ids = applyQuickFilter(rows, "awaiting_bed").map((r) => r.id);
    expect(ids.sort()).toEqual(["b", "c", "d"]);
  });
  it("accepted_not_arrived = accepted with no arrival", () => {
    const ids = applyQuickFilter(rows, "accepted_not_arrived").map((r) => r.id);
    expect(ids).toEqual(["c"]);
  });
  it("discussed_pending = discussed but no outcome", () => {
    const ids = applyQuickFilter(rows, "discussed_pending").map((r) => r.id);
    expect(ids).toEqual(["f"]);
  });
  it("matches helper agrees", () => {
    for (const r of rows) {
      expect(matchesQuickFilter(r, "all")).toBe(true);
    }
  });
});
