import { describe, it, expect } from "vitest";
import { decidePostopSoftDelete } from "./postop-bookings.functions";

const CREATOR = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const ADMIN = "33333333-3333-3333-3333-333333333333";

describe("decidePostopSoftDelete — only creators or admins may soft-delete", () => {
  it("allows the original creator", () => {
    const d = decidePostopSoftDelete(
      { created_by: CREATOR, deleted_at: null },
      CREATOR,
      false,
    );
    expect(d.kind).toBe("allow");
  });

  it("allows any admin, even when not the creator", () => {
    const d = decidePostopSoftDelete(
      { created_by: CREATOR, deleted_at: null },
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

  it("forbids a booking whose created_by is null for non-admins", () => {
    const d = decidePostopSoftDelete(
      { created_by: null, deleted_at: null },
      OTHER,
      false,
    );
    expect(d.kind).toBe("forbidden");
  });

  it("returns not_found when the row is missing (RLS-hidden or unknown id)", () => {
    const d = decidePostopSoftDelete(null, OTHER, false);
    expect(d.kind).toBe("not_found");
  });

  it("is idempotent: an already-deleted row short-circuits without an authz check", () => {
    // Note: userId here is intentionally NOT the creator and NOT admin.
    // The already_deleted branch is safe because the row has already been
    // authorized once and no state change occurs on the second call.
    const d = decidePostopSoftDelete(
      { created_by: CREATOR, deleted_at: "2026-07-02T10:00:00Z" },
      OTHER,
      false,
    );
    expect(d).toEqual({ kind: "already_deleted", deleted_at: "2026-07-02T10:00:00Z" });
  });
});
