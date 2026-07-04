import { describe, it, expect } from "vitest";
import { decidePostopUpdate } from "./postop-bookings.functions";

// Integration-style unit tests focused on the "soft-deleted row" branch of
// `decidePostopUpdate`. Post-op bookings intentionally take a stricter
// stance than referrals: once soft-deleted, NO ONE (creator or admin) may
// update the row via `updatePostopBooking` — restores must go through
// `restorePostopBooking` first. This prevents a stealth restore by writing
// arbitrary fields to a deleted row.
//
// These tests assert that stricter contract, and confirm that a non-creator,
// non-admin clinician is always blocked from touching a soft-deleted row.

const CREATOR = "aaaaaaaa-1111-4111-8111-111111111111";
const CREATOR_UPPER = CREATOR.toUpperCase();
const OTHER = "bbbbbbbb-2222-4222-8222-222222222222";
const ADMIN = "cccccccc-3333-4333-8333-333333333333";
const DELETED_AT = "2026-07-02T10:00:00Z";

describe("decidePostopUpdate on soft-deleted bookings — non-creator/non-admin is blocked", () => {
  it("blocks a random clinician from updating another clinician's soft-deleted booking", () => {
    const d = decidePostopUpdate(
      { created_by: CREATOR, deleted_at: DELETED_AT },
      OTHER,
      false,
    );
    // `already_deleted` is stricter than `forbidden`: the caller learns the
    // row is gone and the write is refused. Either way it is NOT `allow`.
    expect(d.kind).not.toBe("allow");
    expect(d.kind).toBe("already_deleted");
  });

  it("blocks a random clinician from updating a null-creator soft-deleted booking", () => {
    const d = decidePostopUpdate(
      { created_by: null, deleted_at: DELETED_AT },
      OTHER,
      false,
    );
    expect(d.kind).not.toBe("allow");
    expect(d.kind).toBe("already_deleted");
  });

  it("blocks a demoted admin (isAdmin=false) from updating another clinician's soft-deleted booking", () => {
    const d = decidePostopUpdate(
      { created_by: CREATOR, deleted_at: DELETED_AT },
      ADMIN,
      false,
    );
    expect(d.kind).not.toBe("allow");
  });

  it("blocks a caller whose id is a case-mismatched uppercase of the creator id", () => {
    const d = decidePostopUpdate(
      { created_by: CREATOR, deleted_at: DELETED_AT },
      CREATOR_UPPER,
      false,
    );
    expect(d.kind).not.toBe("allow");
  });

  it("blocks an empty-string caller against a null-creator soft-deleted booking", () => {
    const d = decidePostopUpdate(
      { created_by: null, deleted_at: DELETED_AT },
      "",
      false,
    );
    expect(d.kind).not.toBe("allow");
  });
});

describe("decidePostopUpdate on soft-deleted bookings — stealth-restore is blocked for creators and admins too", () => {
  it("blocks even the original creator from updating their own soft-deleted booking", () => {
    // The creator must restore via `restorePostopBooking` first; direct
    // update writes on a deleted row are refused so audit trail stays clean.
    const d = decidePostopUpdate(
      { created_by: CREATOR, deleted_at: DELETED_AT },
      CREATOR,
      false,
    );
    expect(d.kind).not.toBe("allow");
    expect(d).toEqual({ kind: "already_deleted", deleted_at: DELETED_AT });
  });

  it("blocks an admin from stealth-updating a soft-deleted booking they did not create", () => {
    const d = decidePostopUpdate(
      { created_by: CREATOR, deleted_at: DELETED_AT },
      ADMIN,
      true,
    );
    expect(d.kind).not.toBe("allow");
    expect(d.kind).toBe("already_deleted");
  });

  it("blocks an admin from stealth-updating a soft-deleted booking they DID create", () => {
    const d = decidePostopUpdate(
      { created_by: ADMIN, deleted_at: DELETED_AT },
      ADMIN,
      true,
    );
    expect(d.kind).toBe("already_deleted");
  });

  it("blocks an admin from stealth-updating a legacy null-creator soft-deleted booking", () => {
    const d = decidePostopUpdate(
      { created_by: null, deleted_at: DELETED_AT },
      ADMIN,
      true,
    );
    expect(d.kind).toBe("already_deleted");
  });
});

describe("decidePostopUpdate on soft-deleted bookings — surrounding branches still behave", () => {
  it("still allows the creator on a live (not-deleted) booking (regression guard)", () => {
    const d = decidePostopUpdate(
      { created_by: CREATOR, deleted_at: null },
      CREATOR,
      false,
    );
    expect(d.kind).toBe("allow");
  });

  it("still allows an admin on a live booking they did not create (regression guard)", () => {
    const d = decidePostopUpdate(
      { created_by: CREATOR, deleted_at: null },
      ADMIN,
      true,
    );
    expect(d.kind).toBe("allow");
  });

  it("returns not_found (not already_deleted) when the row is missing entirely", () => {
    const d = decidePostopUpdate(null, ADMIN, true);
    expect(d.kind).toBe("not_found");
  });
});
