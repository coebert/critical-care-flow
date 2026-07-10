import { describe, expect, it } from "vitest";
import type { AcuityLevel } from "@/lib/patient-acuity.functions";
import {
  LEVEL_LABEL,
  LEVEL_TONE,
  acuityBadge,
  computeUnitAcuity,
} from "@/lib/acuity";

describe("acuityBadge", () => {
  it("returns null for missing/unset levels so the badge is hidden", () => {
    expect(acuityBadge(null)).toBeNull();
    expect(acuityBadge(undefined)).toBeNull();
  });

  it("returns null for out-of-range levels rather than an empty badge", () => {
    // Values a stale API row or bad manual write could produce.
    expect(acuityBadge(-1 as unknown as AcuityLevel)).toBeNull();
    expect(acuityBadge(4 as unknown as AcuityLevel)).toBeNull();
    expect(acuityBadge(1.5 as unknown as AcuityLevel)).toBeNull();
    expect(acuityBadge("2" as unknown as AcuityLevel)).toBeNull();
  });

  it("maps each valid level to its tone + label + short chip", () => {
    for (const l of [0, 1, 2, 3] as const) {
      const badge = acuityBadge(l);
      expect(badge).not.toBeNull();
      expect(badge!.level).toBe(l);
      expect(badge!.short).toBe(`L${l}`);
      expect(badge!.tone).toBe(LEVEL_TONE[l]);
      expect(badge!.label).toBe(LEVEL_LABEL[l]);
    }
  });

  it("uses distinct tone classes per level so they never collide visually", () => {
    const tones = new Set([LEVEL_TONE[0], LEVEL_TONE[1], LEVEL_TONE[2], LEVEL_TONE[3]]);
    expect(tones.size).toBe(4);
  });
});

describe("computeUnitAcuity", () => {
  it("returns zeroed totals + mean=0 for an empty unit", () => {
    const out = computeUnitAcuity([], new Map());
    expect(out).toEqual({
      counts: { 0: 0, 1: 0, 2: 0, 3: 0 },
      scored: 0,
      unscored: 0,
      total: 0,
      mean: 0,
      meanOrNull: null,
    });
  });

  it("treats missing-from-map, null and undefined identically as unscored", () => {
    const ids = ["a", "b", "c", "d"];
    const map = new Map<string, AcuityLevel | null | undefined>([
      ["b", null],
      ["c", undefined],
      // "a" and "d" simply have no entry
    ]);
    const out = computeUnitAcuity(ids, map);
    expect(out.scored).toBe(0);
    expect(out.unscored).toBe(4);
    expect(out.total).toBe(4);
    expect(out.mean).toBe(0);
    expect(out.meanOrNull).toBeNull();
    expect(out.counts).toEqual({ 0: 0, 1: 0, 2: 0, 3: 0 });
  });

  it("counts a mixed L0–L3 unit and computes the arithmetic mean", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const map = new Map<string, AcuityLevel>([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["d", 3],
      ["e", 3],
      ["f", 2],
    ]);
    const out = computeUnitAcuity(ids, map);
    expect(out.counts).toEqual({ 0: 1, 1: 1, 2: 2, 3: 2 });
    expect(out.scored).toBe(6);
    expect(out.unscored).toBe(0);
    // (0+1+2+3+3+2) / 6 = 11/6
    expect(out.mean).toBeCloseTo(11 / 6, 10);
    expect(out.meanOrNull).toBeCloseTo(11 / 6, 10);
  });

  it("excludes unscored patients from the mean but still counts them in total/unscored", () => {
    const ids = ["a", "b", "c", "d"];
    const map = new Map<string, AcuityLevel | null>([
      ["a", 3],
      ["b", 3],
      ["c", null], // unscored
      // "d" — missing entirely, also unscored
    ]);
    const out = computeUnitAcuity(ids, map);
    expect(out.scored).toBe(2);
    expect(out.unscored).toBe(2);
    expect(out.total).toBe(4);
    // Mean is over scored patients only, not the whole unit.
    expect(out.mean).toBe(3);
    expect(out.meanOrNull).toBe(3);
    expect(out.counts).toEqual({ 0: 0, 1: 0, 2: 0, 3: 2 });
  });

  it("ignores out-of-range values in the acuity map (bucket them as unscored)", () => {
    const ids = ["a", "b", "c"];
    const map = new Map<string, AcuityLevel | null>([
      ["a", 1],
      ["b", -1 as unknown as AcuityLevel],
      ["c", 4 as unknown as AcuityLevel],
    ]);
    const out = computeUnitAcuity(ids, map);
    expect(out.counts).toEqual({ 0: 0, 1: 1, 2: 0, 3: 0 });
    expect(out.scored).toBe(1);
    expect(out.unscored).toBe(2);
    expect(out.mean).toBe(1);
  });

  it("ignores map entries for patient ids not present on the unit", () => {
    const ids = ["a"];
    const map = new Map<string, AcuityLevel>([
      ["a", 2],
      ["ghost", 3], // discharged / no longer on the board
    ]);
    const out = computeUnitAcuity(ids, map);
    expect(out.scored).toBe(1);
    expect(out.total).toBe(1);
    expect(out.counts).toEqual({ 0: 0, 1: 0, 2: 1, 3: 0 });
    expect(out.mean).toBe(2);
  });
});
