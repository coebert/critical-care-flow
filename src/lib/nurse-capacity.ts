// Pure helpers for nurse-based admission capacity.
// Dependency = sum of per-patient care requirement, driven by level of care.
// Mapping (per user spec):
//   Level 3 → 1.0 nurse
//   Level 2 → 0.5 nurse
//   Level 1 → 0.25 nurse
//   Level 0 → 0.25 nurse
// The bed board currently stores level as 1..3 (see admitSchema),
// so level 0 is treated identically to level 1 for completeness.

import type { Occupancy } from "./bed-capacity";

export type Shift = "day" | "night";

export interface NurseStaffingEntry {
  shift_date: string; // YYYY-MM-DD
  shift: Shift;
  available_nurses: number;
}

export interface NurseCapacitySnapshot {
  dependency: number; // total nurses required for current patients
  patient_count: number;
  day: { available: number | null; spare: number | null } & AdmitCapacity;
  night: { available: number | null; spare: number | null } & AdmitCapacity;
}

export interface AdmitCapacity {
  level3_slots: number | null;
  level2_slots: number | null;
  level1_slots: number | null;
}

const LEVEL_WEIGHT: Record<number, number> = {
  0: 0.25,
  1: 0.25,
  2: 0.5,
  3: 1,
};

export function nurseWeightForLevel(level: number | null | undefined): number {
  if (level == null) return 0.25;
  return LEVEL_WEIGHT[level] ?? 0.25;
}

export function computeDependency(occupancies: Occupancy[]): {
  dependency: number;
  patient_count: number;
} {
  const live = occupancies.filter((o) => !o.discharged_at);
  const dependency = live.reduce((sum, o) => sum + nurseWeightForLevel(o.level), 0);
  return { dependency: round2(dependency), patient_count: live.length };
}

export function admissionSlots(spare: number): AdmitCapacity {
  if (!isFinite(spare) || spare <= 0) {
    return { level3_slots: 0, level2_slots: 0, level1_slots: 0 };
  }
  return {
    level3_slots: Math.floor(spare / LEVEL_WEIGHT[3]),
    level2_slots: Math.floor(spare / LEVEL_WEIGHT[2]),
    level1_slots: Math.floor(spare / LEVEL_WEIGHT[1]),
  };
}

function shiftBlock(available: number | null, dependency: number) {
  if (available == null) {
    return {
      available: null,
      spare: null,
      level3_slots: null,
      level2_slots: null,
      level1_slots: null,
    };
  }
  const spare = round2(available - dependency);
  return {
    available,
    spare,
    ...admissionSlots(spare),
  };
}

export function computeNurseCapacity(input: {
  occupancies: Occupancy[];
  day_available: number | null;
  night_available: number | null;
}): NurseCapacitySnapshot {
  const { dependency, patient_count } = computeDependency(input.occupancies);
  return {
    dependency,
    patient_count,
    day: shiftBlock(input.day_available, dependency),
    night: shiftBlock(input.night_available, dependency),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function todayIsoDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
