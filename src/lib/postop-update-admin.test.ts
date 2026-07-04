import { describe, it, expect } from "vitest";
import { decidePostopUpdate } from "./postop-bookings.functions";

// Focused matrix around the admin escape hatch for post-op booking updates:
// admins can update bookings they didn't create, but not stealth-restore
// soft-deleted ones. Complements postop-update-authz.test.ts.

const CREATOR = "aaaaaaaa-1111-4111-8111-111111111111";
const CREATOR_UPPER = CREATOR.toUpperCase();
const OTHER_CLINICIAN = "bbbbbbbb-2222-4222-8222-222222222222";
const ADMIN = "cccccccc-3333-4333-8333-333333333333";
const DELETED_AT = "2026-07-02T10:00:00Z";

describe("decidePostopUpdate — admin override on live bookings", () => {
  it("allows an admin to update a booking created by another clinician", () => {
    const d = decidePostopUpdate(
      { created_by: OTHER_CLINICIAN, deleted_at: null },
      ADMIN,
      true,
    );
    expect(d.kind).toBe("allow");
  });

  it("allows an admin to update their own booking (admin + creator)", () => {
    const d = decidePostopUpdate(
      { created_by: ADMIN, deleted_at: null },
      ADMIN,
      true,
    );
    expect(d.kind).toBe("allow");
  });

  it("allows an admin to update a legacy booking with no recorded creator", () => {
    const d = decidePostopUpdate(
      { created_by: null, deleted_at: null },
      ADMIN,
      true,
    );
    expect(d.kind).toBe("allow");
  });

  it("does not require the admin id to match created_by — role is sufficient", () => {
    // Sanity: even when created_by is a totally unrelated uuid, the admin
    // flag alone unlocks the update.
    const d = decidePostopUpdate(
      { created_by: CREATOR, deleted_at: null },
      ADMIN,
      true,
    );
    expect(d.kind).toBe("allow");
  });
});

describe("decidePostopUpdate — admin override boundary cases", () => {
  it("forbids a user whose admin role was revoked (isAdmin=false) even if they were admin before", () => {
    // The decision reads live role state; a stale token that no longer
    // carries admin must be treated as a normal clinician.
    const d = decidePostopUpdate(
      { created_by: CREATOR, deleted_at: null },
      ADMIN,
      false,
    );
    expect(d.kind).toBe("forbidden");
  });

  it("does NOT let an admin stealth-restore a soft-deleted booking via update", () => {
    const d = decidePostopUpdate(
      { created_by: OTHER_CLINICIAN, deleted_at: DELETED_AT },
      ADMIN,
      true,
    );
    expect(d).toEqual({ kind: "already_deleted", deleted_at: DELETED_AT });
  });

  it("returns not_found for an admin querying an unknown / RLS-hidden row (checked before role)", () => {
    const d = decidePostopUpdate(null, ADMIN, true);
    expect(d.kind).toBe("not_found");
  });

  it("case-sensitive creator match: an uppercase caller id is not the creator and needs the admin flag", () => {
    // Without admin: forbidden.
    const denied = decidePostopUpdate(
      { created_by: CREATOR, deleted_at: null },
      CREATOR_UPPER,
      false,
    );
    expect(denied.kind).toBe("forbidden");

    // With admin: the escape hatch still allows it.
    const allowed = decidePostopUpdate(
      { created_by: CREATOR, deleted_at: null },
      CREATOR_UPPER,
      true,
    );
    expect(allowed.kind).toBe("allow");
  });

  it("admin escape hatch does not bypass 'already_deleted' for null-creator legacy rows either", () => {
    const d = decidePostopUpdate(
      { created_by: null, deleted_at: DELETED_AT },
      ADMIN,
      true,
    );
    expect(d.kind).toBe("already_deleted");
  });
});
