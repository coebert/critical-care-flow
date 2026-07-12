import { describe, it, expect } from "vitest";
import {
  computeDependency,
  admissionSlots,
  computeNurseCapacity,
  nurseWeightForLevel,
} from "./nurse-capacity";
import type { Occupancy } from "./bed-capacity";

function occ(id: string, level: number, discharged = false, oneToOne = false): Occupancy {
  return {
    id,
    bed_id: id,
    discharged_at: discharged ? new Date().toISOString() : null,
    predicted_discharge_at: null,
    level,
    one_to_one: oneToOne,
  };
}

describe("nurseWeightForLevel", () => {
  it("maps levels to nurse weights per spec", () => {
    expect(nurseWeightForLevel(3)).toBe(1);
    expect(nurseWeightForLevel(2)).toBe(0.5);
    expect(nurseWeightForLevel(1)).toBe(0.25);
    expect(nurseWeightForLevel(0)).toBe(0.25);
  });
  it("defaults unknown to 0.25", () => {
    expect(nurseWeightForLevel(null)).toBe(0.25);
    expect(nurseWeightForLevel(99)).toBe(0.25);
  });
});

describe("computeDependency", () => {
  it("sums nurse weights across live patients", () => {
    const r = computeDependency([
      occ("a", 3),
      occ("b", 3),
      occ("c", 2),
      occ("d", 1),
    ]);
    // 1 + 1 + 0.5 + 0.25 = 2.75
    expect(r.dependency).toBe(2.75);
    expect(r.patient_count).toBe(4);
    expect(r.one_to_one_count).toBe(0);
    expect(r.one_to_one_dependency).toBe(0);
    expect(r.level_weighted_dependency).toBe(2.75);
  });
  it("ignores discharged patients", () => {
    const r = computeDependency([occ("a", 3), occ("b", 3, true)]);
    expect(r.dependency).toBe(1);
    expect(r.patient_count).toBe(1);
    expect(r.one_to_one_dependency).toBe(0);
    expect(r.level_weighted_dependency).toBe(1);
  });
  it("breaks out 1:1 dependency from level-weighted dependency", () => {
    const r = computeDependency([
      occ("a", 3, false, true), // 1:1 → 1.0
      occ("b", 3, false, true), // 1:1 → 1.0
      occ("c", 2),              // 0.5
      occ("d", 1),              // 0.25
    ]);
    expect(r.dependency).toBe(2.75);
    expect(r.patient_count).toBe(4);
    expect(r.one_to_one_count).toBe(2);
    expect(r.one_to_one_dependency).toBe(2);
    expect(r.level_weighted_dependency).toBe(0.75);
  });
});

describe("admissionSlots", () => {
  it("returns per-level headroom from spare capacity", () => {
    // Spec example: 10 nurses, dependency 8 → spare 2 → 2 L3 or 4 L2
    expect(admissionSlots(2)).toEqual({
      level3_slots: 2,
      level2_slots: 4,
      level1_slots: 8,
    });
  });
  it("clamps zero/negative spare to no slots", () => {
    expect(admissionSlots(0)).toEqual({ level3_slots: 0, level2_slots: 0, level1_slots: 0 });
    expect(admissionSlots(-1.5)).toEqual({ level3_slots: 0, level2_slots: 0, level1_slots: 0 });
  });
  it("floors fractional spare per level", () => {
    // spare 1.5 → 1 L3, 3 L2, 6 L1
    expect(admissionSlots(1.5)).toEqual({ level3_slots: 1, level2_slots: 3, level1_slots: 6 });
  });
});

describe("computeNurseCapacity", () => {
  it("matches the spec example (10 nurses, dependency 8)", () => {
    // 8 L3 patients → dependency 8
    const patients = Array.from({ length: 8 }, (_, i) => occ(`p${i}`, 3));
    const snap = computeNurseCapacity({
      occupancies: patients,
      day_available: 10,
      night_available: 10,
    });
    expect(snap.dependency).toBe(8);
    expect(snap.one_to_one_dependency).toBe(0);
    expect(snap.level_weighted_dependency).toBe(8);
    expect(snap.day.spare).toBe(2);
    expect(snap.day.level3_slots).toBe(2);
    expect(snap.day.level2_slots).toBe(4);
    expect(snap.night.level3_slots).toBe(2);
  });
  it("null availability yields null slots (not recorded yet)", () => {
    const snap = computeNurseCapacity({
      occupancies: [occ("a", 3)],
      day_available: null,
      night_available: null,
    });
    expect(snap.day.spare).toBeNull();
    expect(snap.day.level3_slots).toBeNull();
    expect(snap.dependency).toBe(1);
    expect(snap.one_to_one_dependency).toBe(0);
    expect(snap.level_weighted_dependency).toBe(1);
  });
});
