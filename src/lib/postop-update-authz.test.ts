import { describe, it, expect } from "vitest";
import { decidePostopUpdate } from "./postop-bookings.functions";

const CREATOR = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const ADMIN = "33333333-3333-3333-3333-333333333333";

describe("decidePostopUpdate — only creators or admins may update", () => {
  it("allows the original creator", () => {
    const d = decidePostopUpdate(
      { created_by: CREATOR, deleted_at: null },
      CREATOR,
      false,
    );
    expect(d.kind).toBe("allow");
  });

  it("allows an admin who is not the creator", () => {
    const d = decidePostopUpdate(
      { created_by: CREATOR, deleted_at: null },
      ADMIN,
      true,
    );
    expect(d.kind).toBe("allow");
  });

  it("forbids another clinician who is neither creator nor admin", () => {
    const d = decidePostopUpdate(
      { created_by: CREATOR, deleted_at: null },
      OTHER,
      false,
    );
    expect(d.kind).toBe("forbidden");
  });

  it("forbids a booking whose created_by is null for non-admins", () => {
    const d = decidePostopUpdate(
      { created_by: null, deleted_at: null },
      OTHER,
      false,
    );
    expect(d.kind).toBe("forbidden");
  });

  it("allows an admin to update a null-creator (legacy) booking", () => {
    const d = decidePostopUpdate(
      { created_by: null, deleted_at: null },
      ADMIN,
      true,
    );
    expect(d.kind).toBe("allow");
  });

  it("returns not_found when the row is missing (RLS-hidden or unknown id)", () => {
    const d = decidePostopUpdate(null, CREATOR, false);
    expect(d.kind).toBe("not_found");
  });

  it("treats a soft-deleted row as already_deleted, even for the creator", () => {
    const d = decidePostopUpdate(
      { created_by: CREATOR, deleted_at: "2026-07-02T10:00:00Z" },
      CREATOR,
      false,
    );
    expect(d).toEqual({ kind: "already_deleted", deleted_at: "2026-07-02T10:00:00Z" });
  });

  it("treats a soft-deleted row as already_deleted for admins too (no stealth restore via update)", () => {
    const d = decidePostopUpdate(
      { created_by: CREATOR, deleted_at: "2026-07-02T10:00:00Z" },
      ADMIN,
      true,
    );
    expect(d.kind).toBe("already_deleted");
  });
});
