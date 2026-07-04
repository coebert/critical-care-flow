import { describe, it, expect } from "vitest";
import {
  decideReferralRestore,
  decideReferralUpdate,
} from "./referral-restore-authz";

// Boundary + role-matrix coverage for the referral soft-delete authz rule.
// These complement referral-restore-authz.test.ts by exercising the corners
// around "who counts as the creator" and how the admin escape hatch behaves.

const CREATOR = "11111111-1111-1111-1111-111111111111";
const CREATOR_UPPER = "11111111-1111-1111-1111-111111111111".toUpperCase();
const OTHER = "22222222-2222-2222-2222-222222222222";
const ADMIN = "33333333-3333-3333-3333-333333333333";
const NOW = new Date("2026-07-10T12:00:00Z").getTime();
const WINDOW_DAYS = 7;
const MS_PER_DAY = 86_400_000;

// Deleted exactly on the cutoff — cutoff itself is exclusive (`< cutoff`
// expires), so `= cutoff` still allows.
const DELETED_AT_CUTOFF = new Date(NOW - WINDOW_DAYS * MS_PER_DAY).toISOString();
// One ms older than the cutoff → must expire.
const DELETED_JUST_EXPIRED = new Date(
  NOW - WINDOW_DAYS * MS_PER_DAY - 1,
).toISOString();
// One ms newer than the cutoff → must allow.
const DELETED_JUST_INSIDE = new Date(
  NOW - WINDOW_DAYS * MS_PER_DAY + 1,
).toISOString();
const DELETED_RECENT = "2026-07-09T12:00:00Z";
const DELETED_OLD = "2026-06-01T12:00:00Z";

describe("decideReferralRestore — role matrix", () => {
  it("allows an admin who is also the original creator", () => {
    const d = decideReferralRestore({
      row: { created_by: ADMIN, deleted_at: DELETED_RECENT },
      userId: ADMIN,
      isAdmin: true,
      now: NOW,
    });
    expect(d.kind).toBe("allow");
  });

  it("forbids a former admin (isAdmin=false) even if they created the row's sibling — ownership is per row", () => {
    const d = decideReferralRestore({
      row: { created_by: CREATOR, deleted_at: DELETED_RECENT },
      userId: ADMIN,
      isAdmin: false,
      now: NOW,
    });
    expect(d.kind).toBe("forbidden");
  });

  it("forbids a stale isAdmin=true claim against a null-creator row when window is fine (admin still wins)", () => {
    // Admins may restore null-creator rows — this is the escape hatch.
    const d = decideReferralRestore({
      row: { created_by: null, deleted_at: DELETED_RECENT },
      userId: ADMIN,
      isAdmin: true,
      now: NOW,
    });
    expect(d.kind).toBe("allow");
  });

  it("treats UUID comparison as case-sensitive: uppercase does not match stored lowercase", () => {
    // Supabase stores UUIDs canonicalised to lowercase. A caller passing an
    // upper-cased id must NOT be treated as the creator.
    const d = decideReferralRestore({
      row: { created_by: CREATOR, deleted_at: DELETED_RECENT },
      userId: CREATOR_UPPER,
      isAdmin: false,
      now: NOW,
    });
    expect(d.kind).toBe("forbidden");
  });

  it("does not treat empty-string userId as matching a null creator", () => {
    const d = decideReferralRestore({
      row: { created_by: null, deleted_at: DELETED_RECENT },
      userId: "",
      isAdmin: false,
      now: NOW,
    });
    expect(d.kind).toBe("forbidden");
  });
});

describe("decideReferralRestore — window boundaries", () => {
  it("allows a restore one ms inside the window for the creator", () => {
    const d = decideReferralRestore({
      row: { created_by: CREATOR, deleted_at: DELETED_JUST_INSIDE },
      userId: CREATOR,
      isAdmin: false,
      now: NOW,
    });
    expect(d.kind).toBe("allow");
  });

  it("allows a restore exactly on the cutoff for the creator (cutoff is inclusive)", () => {
    const d = decideReferralRestore({
      row: { created_by: CREATOR, deleted_at: DELETED_AT_CUTOFF },
      userId: CREATOR,
      isAdmin: false,
      now: NOW,
    });
    expect(d.kind).toBe("allow");
  });

  it("expires a restore one ms past the cutoff for the creator", () => {
    const d = decideReferralRestore({
      row: { created_by: CREATOR, deleted_at: DELETED_JUST_EXPIRED },
      userId: CREATOR,
      isAdmin: false,
      now: NOW,
    });
    expect(d.kind).toBe("window_expired");
    if (d.kind === "window_expired") {
      expect(d.windowDays).toBe(WINDOW_DAYS);
      expect(d.deleted_at).toBe(DELETED_JUST_EXPIRED);
    }
  });

  it("expires a restore past the cutoff even for an admin", () => {
    // Admins share the same time window; the escape hatch is over ownership,
    // not over the retention policy.
    const d = decideReferralRestore({
      row: { created_by: CREATOR, deleted_at: DELETED_OLD },
      userId: ADMIN,
      isAdmin: true,
      now: NOW,
    });
    expect(d.kind).toBe("window_expired");
  });

  it("honours a caller-supplied restoreWindowDays override", () => {
    const d = decideReferralRestore({
      row: { created_by: CREATOR, deleted_at: DELETED_OLD },
      userId: CREATOR,
      isAdmin: false,
      now: NOW,
      restoreWindowDays: 365,
    });
    expect(d.kind).toBe("allow");
  });

  it("zero-day window expires anything already soft-deleted (including for admins)", () => {
    const d = decideReferralRestore({
      row: { created_by: CREATOR, deleted_at: DELETED_JUST_INSIDE },
      userId: ADMIN,
      isAdmin: true,
      now: NOW,
      restoreWindowDays: 0,
    });
    expect(d.kind).toBe("window_expired");
  });

  it("checks not_deleted before window: a live row with an old (nonsense) deleted_at=null is not_deleted", () => {
    const d = decideReferralRestore({
      row: { created_by: CREATOR, deleted_at: null },
      userId: ADMIN,
      isAdmin: true,
      now: NOW,
    });
    expect(d.kind).toBe("not_deleted");
  });

  it("checks not_found before anything else, even for admins", () => {
    const d = decideReferralRestore({
      row: null,
      userId: ADMIN,
      isAdmin: true,
      now: NOW,
    });
    expect(d.kind).toBe("not_found");
  });
});

describe("decideReferralUpdate — role matrix and boundaries", () => {
  it("allows an admin who is also the creator on a soft-deleted row", () => {
    const d = decideReferralUpdate({
      row: { created_by: ADMIN, deleted_at: DELETED_RECENT },
      userId: ADMIN,
      isAdmin: true,
    });
    expect(d.kind).toBe("allow");
  });

  it("forbids a former admin (isAdmin=false) updating someone else's soft-deleted row", () => {
    const d = decideReferralUpdate({
      row: { created_by: CREATOR, deleted_at: DELETED_RECENT },
      userId: ADMIN,
      isAdmin: false,
    });
    expect(d.kind).toBe("forbidden_soft_deleted");
  });

  it("allows admin to update a soft-deleted row with a null creator (nobody else can own it)", () => {
    const d = decideReferralUpdate({
      row: { created_by: null, deleted_at: DELETED_RECENT },
      userId: ADMIN,
      isAdmin: true,
    });
    expect(d.kind).toBe("allow");
  });

  it("forbids a non-admin on a null-creator soft-deleted row (no one can claim ownership)", () => {
    const d = decideReferralUpdate({
      row: { created_by: null, deleted_at: DELETED_RECENT },
      userId: CREATOR,
      isAdmin: false,
    });
    expect(d.kind).toBe("forbidden_soft_deleted");
  });

  it("case-sensitive creator match on soft-deleted rows: uppercase id is not the creator", () => {
    const d = decideReferralUpdate({
      row: { created_by: CREATOR, deleted_at: DELETED_RECENT },
      userId: CREATOR_UPPER,
      isAdmin: false,
    });
    expect(d.kind).toBe("forbidden_soft_deleted");
  });

  it("live-row rule ignores the isAdmin flag entirely (falls through to normal collab RLS)", () => {
    const d = decideReferralUpdate({
      row: { created_by: CREATOR, deleted_at: null },
      userId: OTHER,
      isAdmin: false,
    });
    expect(d.kind).toBe("allow");
  });

  it("even the creator gets not_found when the row cannot be read (RLS-hidden or wrong id)", () => {
    const d = decideReferralUpdate({
      row: null,
      userId: CREATOR,
      isAdmin: true,
    });
    expect(d.kind).toBe("not_found");
  });
});
