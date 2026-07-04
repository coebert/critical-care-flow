import { describe, it, expect } from "vitest";
import {
  decideReferralRestore,
  decideReferralUpdate,
} from "./referral-restore-authz";

const CREATOR = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const ADMIN = "33333333-3333-3333-3333-333333333333";
const NOW = new Date("2026-07-10T12:00:00Z").getTime();
const DELETED_RECENT = "2026-07-09T12:00:00Z"; // 1 day ago
const DELETED_OLD = "2026-06-01T12:00:00Z"; // > 7 days ago

describe("decideReferralRestore — only creators or admins may restore", () => {
  it("allows the original creator to restore within window", () => {
    const d = decideReferralRestore({
      row: { created_by: CREATOR, deleted_at: DELETED_RECENT },
      userId: CREATOR,
      isAdmin: false,
      now: NOW,
    });
    expect(d.kind).toBe("allow");
  });

  it("allows an admin who is not the creator", () => {
    const d = decideReferralRestore({
      row: { created_by: CREATOR, deleted_at: DELETED_RECENT },
      userId: ADMIN,
      isAdmin: true,
      now: NOW,
    });
    expect(d.kind).toBe("allow");
  });

  it("forbids another clinician who is neither creator nor admin", () => {
    const d = decideReferralRestore({
      row: { created_by: CREATOR, deleted_at: DELETED_RECENT },
      userId: OTHER,
      isAdmin: false,
      now: NOW,
    });
    expect(d.kind).toBe("forbidden");
  });

  it("forbids a null-creator row for non-admins", () => {
    const d = decideReferralRestore({
      row: { created_by: null, deleted_at: DELETED_RECENT },
      userId: OTHER,
      isAdmin: false,
      now: NOW,
    });
    expect(d.kind).toBe("forbidden");
  });

  it("returns not_found when the row is missing (RLS-hidden or unknown id)", () => {
    const d = decideReferralRestore({
      row: null,
      userId: CREATOR,
      isAdmin: false,
      now: NOW,
    });
    expect(d.kind).toBe("not_found");
  });

  it("returns not_deleted when the row is live", () => {
    const d = decideReferralRestore({
      row: { created_by: CREATOR, deleted_at: null },
      userId: CREATOR,
      isAdmin: false,
      now: NOW,
    });
    expect(d.kind).toBe("not_deleted");
  });

  it("rejects a restore once the restore window has expired, even for the creator", () => {
    const d = decideReferralRestore({
      row: { created_by: CREATOR, deleted_at: DELETED_OLD },
      userId: CREATOR,
      isAdmin: false,
      now: NOW,
    });
    expect(d.kind).toBe("window_expired");
  });

  it("still checks ownership before window: a non-creator gets forbidden, not window_expired", () => {
    const d = decideReferralRestore({
      row: { created_by: CREATOR, deleted_at: DELETED_OLD },
      userId: OTHER,
      isAdmin: false,
      now: NOW,
    });
    expect(d.kind).toBe("forbidden");
  });
});

describe("decideReferralUpdate — soft-deleted rows may only be mutated by creator/admin", () => {
  it("allows any authorized editor on a live row (collaborative editing preserved)", () => {
    const d = decideReferralUpdate({
      row: { created_by: CREATOR, deleted_at: null },
      userId: OTHER,
      isAdmin: false,
    });
    expect(d.kind).toBe("allow");
  });

  it("forbids a non-creator, non-admin from updating a soft-deleted row (blocks stealth restore)", () => {
    const d = decideReferralUpdate({
      row: { created_by: CREATOR, deleted_at: DELETED_RECENT },
      userId: OTHER,
      isAdmin: false,
    });
    expect(d.kind).toBe("forbidden_soft_deleted");
  });

  it("allows the creator to mutate their own soft-deleted row", () => {
    const d = decideReferralUpdate({
      row: { created_by: CREATOR, deleted_at: DELETED_RECENT },
      userId: CREATOR,
      isAdmin: false,
    });
    expect(d.kind).toBe("allow");
  });

  it("allows an admin to mutate a soft-deleted row owned by someone else", () => {
    const d = decideReferralUpdate({
      row: { created_by: CREATOR, deleted_at: DELETED_RECENT },
      userId: ADMIN,
      isAdmin: true,
    });
    expect(d.kind).toBe("allow");
  });

  it("returns not_found for a missing row", () => {
    const d = decideReferralUpdate({
      row: null,
      userId: CREATOR,
      isAdmin: false,
    });
    expect(d.kind).toBe("not_found");
  });
});
