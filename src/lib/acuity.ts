/**
 * Pure helpers for patient acuity display + unit-level aggregation.
 *
 * Extracted from the bed-board route so the level→badge mapping and the
 * unit acuity calculation can be unit-tested in isolation from React /
 * TanStack / the partner bridge fetch.
 */

import type { AcuityLevel } from "@/lib/patient-acuity.functions";

export const LEVEL_TONE: Record<AcuityLevel, string> = {
  0: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  1: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/30",
  2: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
  3: "bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/30",
};

export const LEVEL_LABEL: Record<AcuityLevel, string> = {
  0: "Level 0 — ward-level care",
  1: "Level 1 — at risk of deterioration",
  2: "Level 2 — HDU care",
  3: "Level 3 — ICU care",
};

/**
 * Badge descriptor for a single patient's per-bed acuity chip. Returns
 * `null` when the level is missing (null / undefined / not a valid L0–L3),
 * which the caller uses to hide the badge entirely rather than render an
 * empty pill.
 */
export function acuityBadge(
  level: AcuityLevel | null | undefined,
): { level: AcuityLevel; tone: string; label: string; short: string } | null {
  if (level == null) return null;
  if (level !== 0 && level !== 1 && level !== 2 && level !== 3) return null;
  return {
    level,
    tone: LEVEL_TONE[level],
    label: LEVEL_LABEL[level],
    short: `L${level}`,
  };
}

export type UnitAcuity = {
  counts: Record<AcuityLevel, number>;
  scored: number;
  unscored: number;
  total: number;
  mean: number; // 0 when no patients are scored — matches the UI display
  meanOrNull: number | null; // null when nothing scored, for callers that need to hide the value
};

/**
 * Aggregate a per-patient acuity map into unit totals.
 *
 * - Patients whose id is missing from the map, or whose level is null /
 *   undefined / out-of-range, count as "unscored".
 * - `mean` is the arithmetic mean of scored patients, or 0 when none are
 *   scored (matches the current header display).
 */
export function computeUnitAcuity(
  patientIds: ReadonlyArray<string>,
  acuityMap: ReadonlyMap<string, AcuityLevel | null | undefined>,
): UnitAcuity {
  const counts: Record<AcuityLevel, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  let scored = 0;
  let sum = 0;
  for (const id of patientIds) {
    const l = acuityMap.get(id);
    if (l == null) continue;
    if (l !== 0 && l !== 1 && l !== 2 && l !== 3) continue;
    counts[l] += 1;
    scored += 1;
    sum += l;
  }
  const total = patientIds.length;
  const unscored = total - scored;
  const mean = scored > 0 ? sum / scored : 0;
  return {
    counts,
    scored,
    unscored,
    total,
    mean,
    meanOrNull: scored > 0 ? mean : null,
  };
}
