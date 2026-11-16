import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseBedBoardSearch, hasLegacyIdentifierParams } from "./bed-board-search";

const REF = "11111111-2222-4333-8444-555555555555";

describe("bed board URL carries no patient identifiers", () => {
  it("validateSearch drops identifier params and accepts only opaque ids + neutral labels", () => {
    const out = parseBedBoardSearch({
      source_referral_id: REF,
      hospital_number: "SYN0000001",
      patient_initials: "AB",
      admitting_consultant: "Dr Synthetic",
      level: 3,
      source_label: "referral SYN0000001",
    });
    expect(out).toEqual({ source_referral_id: REF });
    expect(parseBedBoardSearch({ source_referral_id: REF, source_label: "referral" })).toEqual({
      source_referral_id: REF,
      source_label: "referral",
    });
  });

  it("rejects non-UUID source ids", () => {
    expect(parseBedBoardSearch({ source_referral_id: "SYN0000001" })).toEqual({});
  });

  it("keeps alert deep-link focus params", () => {
    expect(parseBedBoardSearch({ focus_shift: "night", focus_level: 2 })).toEqual({
      focus_shift: "night",
      focus_level: 2,
    });
  });

  it("detects legacy identifier links so they can be rewritten", () => {
    expect(hasLegacyIdentifierParams(new URLSearchParams("hospital_number=SYN1"))).toBe(true);
    expect(hasLegacyIdentifierParams(new URLSearchParams("source_label=referral%20SYN1"))).toBe(true);
    expect(hasLegacyIdentifierParams(new URLSearchParams(`source_referral_id=${REF}&source_label=referral`))).toBe(false);
  });

  it.each([
    "src/routes/_authenticated/referrals.$id.tsx",
    "src/routes/_authenticated/postop-bookings.$id.edit.tsx",
  ])("%s links to the bed board without identifiers", (file) => {
    const src = readFileSync(file, "utf8");
    const idx = src.indexOf('to: "/bed-board"');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, src.indexOf("})", idx));
    expect(block).not.toMatch(/hospital_number|patient_initials|admitting_consultant|hospitalNumber|accepting_consultant/);
  });
});

describe("validated search overrides raw URL values", () => {
  it("returns every legacy/unvalidated key explicitly so router merging cannot leak raw values", () => {
    const out = parseBedBoardSearch({ hospital_number: "SYN1", source_label: "referral SYN1" });
    const raw = { hospital_number: "SYN1", source_label: "referral SYN1" };
    const merged = { ...raw, ...out };
    expect(merged.hospital_number).toBeUndefined();
    expect(merged.source_label).toBeUndefined();
  });
});
