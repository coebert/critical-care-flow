import { describe, it, expect } from "vitest";
import { computeViaAdminFlow } from "./encrypted-notes.functions";

const AUTHOR = "00000000-0000-0000-0000-00000000aaaa";
const ADMIN = "00000000-0000-0000-0000-00000000bbbb";
const RECIPIENT = "00000000-0000-0000-0000-00000000cccc";

describe("computeViaAdminFlow — actor identity vs original note author", () => {
  it("returns false when the author edits their own note (create path)", () => {
    // create passes author_id = userId (the actor is the author)
    expect(computeViaAdminFlow(AUTHOR, AUTHOR)).toBe(false);
  });

  it("returns false when the author edits their own existing note (update path)", () => {
    // update passes author_id = existing.author_id; actor == author
    expect(computeViaAdminFlow(AUTHOR, AUTHOR)).toBe(false);
  });

  it("returns true when an admin edits another user's note", () => {
    expect(computeViaAdminFlow(ADMIN, AUTHOR)).toBe(true);
  });

  it("returns true when an admin deletes-and-reinserts (re-encrypts) another user's note", () => {
    // Admin re-encrypt flow: actor = admin, author preserved as original AUTHOR
    expect(computeViaAdminFlow(ADMIN, AUTHOR)).toBe(true);
  });

  it("returns false when an admin edits a note they themselves authored", () => {
    // Edge case: admin re-encrypts their OWN note. Not an admin-flow edit.
    expect(computeViaAdminFlow(ADMIN, ADMIN)).toBe(false);
  });

  it("returns true when a non-admin recipient somehow acts on another user's note", () => {
    // (RLS would block this, but the flag should still classify it as non-author.)
    expect(computeViaAdminFlow(RECIPIENT, AUTHOR)).toBe(true);
  });

  it("returns false conservatively when author_id is unknown (undefined)", () => {
    expect(computeViaAdminFlow(ADMIN, undefined)).toBe(false);
  });

  it("returns false conservatively when author_id is null", () => {
    expect(computeViaAdminFlow(ADMIN, null)).toBe(false);
  });

  it("distinguishes actors that differ only by case (strict equality)", () => {
    // UUIDs are canonical lowercase, but confirm we don't accidentally case-fold.
    expect(computeViaAdminFlow(AUTHOR.toUpperCase(), AUTHOR)).toBe(true);
  });
});
