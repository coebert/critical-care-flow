import { describe, it, expect } from "vitest";
import { decidePostopRestore } from "./postop-bookings.functions";

// Integration-style unit tests for the restore authorization rule on
// post-op bookings. A soft-deleted booking may only be restored by its
// original creator or by an admin. The pure `decidePostopRestore` mirrors
// the `postop_bookings_guard_soft_delete` trigger, so exercising it here
// is equivalent to exercising the RLS gate without a live database.

const CREATOR = "aaaaaaaa-1111-4111-8111-111111111111";
const CREATOR_UPPER = CREATOR.toUpperCase();
const OTHER = "bbbbbbbb-2222-4222-8222-222222222222";
const ADMIN = "cccccccc-3333-4333-8333-333333333333";
const DELETED_AT = "2026-07-02T10:00:00Z";

describe("decidePostopRestore — only creators or admins may restore", () => {
  it("allows the original creator to restore their own soft-deleted booking", () => {
    const d = decidePostopRestore(
      { created_by: CREATOR, deleted_at: DELETED_AT },
      CREATOR,
      false,
    );
    expect(d.kind).toBe("allow");
  });

  it("allows an admin who is not the creator", () => {
    const d = decidePostopRestore(
      { created_by: CREATOR, deleted_at: DELETED_AT },
      ADMIN,
      true,
    );
    expect(d.kind).toBe("allow");
  });

  it("allows an admin who is also the creator", () => {
    const d = decidePostopRestore(
      { created_by: ADMIN, deleted_at: DELETED_AT },
      ADMIN,
      true,
    );
    expect(d.kind).toBe("allow");
  });

  it("allows an admin to restore a legacy null-creator booking", () => {
    const d = decidePostopRestore(
      { created_by: null, deleted_at: DELETED_AT },
      ADMIN,
      true,
    );
    expect(d.kind).toBe("allow");
  });

  it("forbids another clinician who is neither creator nor admin", () => {
    const d = decidePostopRestore(
      { created_by: CREATOR, deleted_at: DELETED_AT },
      OTHER,
      false,
    );
    expect(d.kind).toBe("forbidden");
  });

  it("forbids a null-creator soft-deleted booking for a non-admin (no one can claim ownership)", () => {
    const d = decidePostopRestore(
      { created_by: null, deleted_at: DELETED_AT },
      OTHER,
      false,
    );
    expect(d.kind).toBe("forbidden");
  });

  it("forbids a user whose admin role was revoked (isAdmin=false) even against their own past-created row", () => {
    // If we accidentally read stale role state, a former admin must be
    // treated as a normal clinician and denied.
    const d = decidePostopRestore(
      { created_by: CREATOR, deleted_at: DELETED_AT },
      ADMIN,
      false,
    );
    expect(d.kind).toBe("forbidden");
  });
});

describe("decidePostopRestore — preconditions and boundaries", () => {
  it("returns not_found when the row is missing (RLS-hidden or unknown id), even for admins", () => {
    const d = decidePostopRestore(null, ADMIN, true);
    expect(d.kind).toBe("not_found");
  });

  it("returns not_deleted when the booking is live (creator asking)", () => {
    const d = decidePostopRestore(
      { created_by: CREATOR, deleted_at: null },
      CREATOR,
      false,
    );
    expect(d.kind).toBe("not_deleted");
  });

  it("returns not_deleted when the booking is live (admin asking) — no-op restore short-circuits before authz", () => {
    const d = decidePostopRestore(
      { created_by: CREATOR, deleted_at: null },
      ADMIN,
      true,
    );
    expect(d.kind).toBe("not_deleted");
  });

  it("checks ownership even when the row is live for non-admins? No — live rows fall through to not_deleted first", () => {
    // Documents the ordering: not_deleted takes precedence over forbidden.
    const d = decidePostopRestore(
      { created_by: CREATOR, deleted_at: null },
      OTHER,
      false,
    );
    expect(d.kind).toBe("not_deleted");
  });

  it("case-sensitive creator match: an uppercase caller id is not the creator", () => {
    const denied = decidePostopRestore(
      { created_by: CREATOR, deleted_at: DELETED_AT },
      CREATOR_UPPER,
      false,
    );
    expect(denied.kind).toBe("forbidden");

    // Same caller, but admin flag on: the escape hatch still allows it.
    const allowed = decidePostopRestore(
      { created_by: CREATOR, deleted_at: DELETED_AT },
      CREATOR_UPPER,
      true,
    );
    expect(allowed.kind).toBe("allow");
  });

  it("does not treat empty-string userId as matching a null creator", () => {
    const d = decidePostopRestore(
      { created_by: null, deleted_at: DELETED_AT },
      "",
      false,
    );
    expect(d.kind).toBe("forbidden");
  });
});
