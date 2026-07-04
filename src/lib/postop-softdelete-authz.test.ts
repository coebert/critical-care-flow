import { describe, it, expect } from "vitest";
import { decidePostopSoftDelete } from "./postop-bookings.functions";

// Integration-style unit tests for the soft-delete authorization rule on
// post-op bookings. A booking may only be soft-deleted by its original
// creator or by an admin. `decidePostopSoftDelete` mirrors the RLS/trigger
// policy, so exercising every branch here is equivalent to exercising the
// database gate without a live Supabase context.

const CREATOR = "aaaaaaaa-1111-4111-8111-111111111111";
const CREATOR_UPPER = CREATOR.toUpperCase();
const OTHER = "bbbbbbbb-2222-4222-8222-222222222222";
const ADMIN = "cccccccc-3333-4333-8333-333333333333";
const DELETED_AT = "2026-07-02T10:00:00Z";

describe("decidePostopSoftDelete — only creators or admins may soft-delete", () => {
  it("allows the original creator to soft-delete their own booking", () => {
    const d = decidePostopSoftDelete(
      { created_by: CREATOR, deleted_at: null },
      CREATOR,
      false,
    );
    expect(d.kind).toBe("allow");
  });

  it("allows an admin to soft-delete another clinician's booking", () => {
    const d = decidePostopSoftDelete(
      { created_by: CREATOR, deleted_at: null },
      ADMIN,
      true,
    );
    expect(d.kind).toBe("allow");
  });

  it("allows an admin who is also the creator", () => {
    const d = decidePostopSoftDelete(
      { created_by: ADMIN, deleted_at: null },
      ADMIN,
      true,
    );
    expect(d.kind).toBe("allow");
  });

  it("allows an admin to soft-delete a legacy null-creator booking", () => {
    const d = decidePostopSoftDelete(
      { created_by: null, deleted_at: null },
      ADMIN,
      true,
    );
    expect(d.kind).toBe("allow");
  });

  it("forbids another clinician who is neither creator nor admin", () => {
    const d = decidePostopSoftDelete(
      { created_by: CREATOR, deleted_at: null },
      OTHER,
      false,
    );
    expect(d.kind).toBe("forbidden");
  });

  it("forbids a non-admin from soft-deleting a null-creator booking (no one can claim ownership)", () => {
    const d = decidePostopSoftDelete(
      { created_by: null, deleted_at: null },
      OTHER,
      false,
    );
    expect(d.kind).toBe("forbidden");
  });

  it("forbids a user whose admin role was revoked (isAdmin=false) against another clinician's booking", () => {
    // Stale token / demoted user must be treated as a normal clinician.
    const d = decidePostopSoftDelete(
      { created_by: CREATOR, deleted_at: null },
      ADMIN,
      false,
    );
    expect(d.kind).toBe("forbidden");
  });
});

describe("decidePostopSoftDelete — preconditions and boundaries", () => {
  it("returns not_found when the row is missing (RLS-hidden or unknown id), even for admins", () => {
    const d = decidePostopSoftDelete(null, ADMIN, true);
    expect(d.kind).toBe("not_found");
  });

  it("returns already_deleted when the booking is already soft-deleted (creator asking)", () => {
    const d = decidePostopSoftDelete(
      { created_by: CREATOR, deleted_at: DELETED_AT },
      CREATOR,
      false,
    );
    expect(d).toEqual({ kind: "already_deleted", deleted_at: DELETED_AT });
  });

  it("returns already_deleted for admins too — idempotent, no re-timestamp", () => {
    const d = decidePostopSoftDelete(
      { created_by: CREATOR, deleted_at: DELETED_AT },
      ADMIN,
      true,
    );
    expect(d.kind).toBe("already_deleted");
  });

  it("already_deleted takes precedence over forbidden for a non-creator, non-admin", () => {
    // Documents ordering: the caller learns the row is already gone rather
    // than that they lack permission to delete it.
    const d = decidePostopSoftDelete(
      { created_by: CREATOR, deleted_at: DELETED_AT },
      OTHER,
      false,
    );
    expect(d.kind).toBe("already_deleted");
  });

  it("case-sensitive creator match: an uppercase caller id is not the creator", () => {
    const denied = decidePostopSoftDelete(
      { created_by: CREATOR, deleted_at: null },
      CREATOR_UPPER,
      false,
    );
    expect(denied.kind).toBe("forbidden");

    // Same caller with the admin flag: the escape hatch still allows it.
    const allowed = decidePostopSoftDelete(
      { created_by: CREATOR, deleted_at: null },
      CREATOR_UPPER,
      true,
    );
    expect(allowed.kind).toBe("allow");
  });

  it("does not treat empty-string userId as matching a null creator", () => {
    const d = decidePostopSoftDelete(
      { created_by: null, deleted_at: null },
      "",
      false,
    );
    expect(d.kind).toBe("forbidden");
  });
});
