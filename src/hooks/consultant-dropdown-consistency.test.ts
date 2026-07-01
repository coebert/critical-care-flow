import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Guardrail: both the new-referral and edit-referral routes must source their
// consultant dropdown options from the shared useReferralOptions hook so the
// ordering (surname-first, deterministic tie-break) is identical on both.
const FILES = [
  "src/routes/_authenticated/referrals.new.tsx",
  "src/routes/_authenticated/referrals.$id.tsx",
];

describe("consultant dropdown consistency", () => {
  for (const rel of FILES) {
    it(`${rel} uses useReferralOptions and feeds consultants to both consultant fields`, () => {
      const src = readFileSync(resolve(process.cwd(), rel), "utf8");
      expect(src).toMatch(/from ["']@\/hooks\/use-referral-options["']/);
      expect(src).toMatch(/useReferralOptions\(\)/);
      // Both the accepting- and discussed-with fields must read from the same
      // sorted `consultants` array (two references, one per combobox).
      const matches = src.match(/options=\{consultants\}/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });
  }
});
