import { describe, it, expect } from "vitest";
import {
  canAccessReferralNoteKey,
  type Caller,
  type KeyRow,
  type Op,
} from "./referral-note-keys-authz";

const AUTHOR = "11111111-1111-1111-1111-111111111111";
const RECIPIENT = "22222222-2222-2222-2222-222222222222";
const OTHER_RECIPIENT = "33333333-3333-3333-3333-333333333333";
const ADMIN = "44444444-4444-4444-4444-444444444444";
const OUTSIDER = "55555555-5555-5555-5555-555555555555";

const row = (recipient: string): KeyRow => ({
  note_author_id: AUTHOR,
  recipient_user_id: recipient,
});
const caller = (userId: string, isAdmin = false): Caller => ({ userId, isAdmin });

describe("referral_note_keys RLS — SELECT", () => {
  const op: Op = "select";
  it("recipient reads their own wrapped key row", () => {
    expect(canAccessReferralNoteKey(op, row(RECIPIENT), caller(RECIPIENT))).toBe(true);
  });
  it("author reads any recipient row on their note", () => {
    expect(canAccessReferralNoteKey(op, row(RECIPIENT), caller(AUTHOR))).toBe(true);
    expect(canAccessReferralNoteKey(op, row(OTHER_RECIPIENT), caller(AUTHOR))).toBe(true);
  });
  it("admin reads any row (audit + edit path)", () => {
    expect(canAccessReferralNoteKey(op, row(RECIPIENT), caller(ADMIN, true))).toBe(true);
  });
  it("another recipient cannot read a peer's wrapped key", () => {
    expect(
      canAccessReferralNoteKey(op, row(RECIPIENT), caller(OTHER_RECIPIENT)),
    ).toBe(false);
  });
  it("outsider (no role, not addressed) cannot read", () => {
    expect(canAccessReferralNoteKey(op, row(RECIPIENT), caller(OUTSIDER))).toBe(false);
  });
});

describe("referral_note_keys RLS — INSERT", () => {
  const op: Op = "insert";
  it("author inserts recipient keys on their own note", () => {
    expect(canAccessReferralNoteKey(op, row(RECIPIENT), caller(AUTHOR))).toBe(true);
  });
  it("admin inserts recipient keys during admin edit (regression: previously blocked)", () => {
    expect(canAccessReferralNoteKey(op, row(RECIPIENT), caller(ADMIN, true))).toBe(true);
  });
  it("a recipient cannot add themselves or others as recipients", () => {
    expect(canAccessReferralNoteKey(op, row(RECIPIENT), caller(RECIPIENT))).toBe(false);
    expect(
      canAccessReferralNoteKey(op, row(OTHER_RECIPIENT), caller(RECIPIENT)),
    ).toBe(false);
  });
  it("outsider cannot insert", () => {
    expect(canAccessReferralNoteKey(op, row(RECIPIENT), caller(OUTSIDER))).toBe(false);
  });
});

describe("referral_note_keys RLS — DELETE", () => {
  const op: Op = "delete";
  it("author deletes their note's recipient keys (during key rotation)", () => {
    expect(canAccessReferralNoteKey(op, row(RECIPIENT), caller(AUTHOR))).toBe(true);
  });
  it("admin deletes during admin edit", () => {
    expect(canAccessReferralNoteKey(op, row(RECIPIENT), caller(ADMIN, true))).toBe(true);
  });
  it("recipient cannot delete their own key row", () => {
    expect(canAccessReferralNoteKey(op, row(RECIPIENT), caller(RECIPIENT))).toBe(false);
  });
  it("outsider cannot delete", () => {
    expect(canAccessReferralNoteKey(op, row(RECIPIENT), caller(OUTSIDER))).toBe(false);
  });
});

describe("referral_note_keys RLS — admin edit round trip", () => {
  // Reproduces the previously-broken flow: admin edits a note authored by
  // someone else; DELETE succeeded but INSERT was blocked, leaving the note
  // unreadable. After the policy fix, every step is permitted.
  const admin = caller(ADMIN, true);
  const recipients = [RECIPIENT, OTHER_RECIPIENT];

  it("admin can delete all existing recipient keys", () => {
    for (const r of recipients) {
      expect(canAccessReferralNoteKey("delete", row(r), admin)).toBe(true);
    }
  });
  it("admin can insert fresh recipient keys", () => {
    for (const r of recipients) {
      expect(canAccessReferralNoteKey("insert", row(r), admin)).toBe(true);
    }
  });
  it("each recipient can still read their re-wrapped key afterwards", () => {
    expect(canAccessReferralNoteKey("select", row(RECIPIENT), caller(RECIPIENT))).toBe(true);
    expect(
      canAccessReferralNoteKey("select", row(OTHER_RECIPIENT), caller(OTHER_RECIPIENT)),
    ).toBe(true);
  });
  it("original author retains full visibility across recipient rows", () => {
    for (const r of recipients) {
      expect(canAccessReferralNoteKey("select", row(r), caller(AUTHOR))).toBe(true);
    }
  });
});
