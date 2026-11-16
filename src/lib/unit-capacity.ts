/**
 * The ONE capacity calculation used by every surface (Bed Board, TV board,
 * referral badge / callout / mini link) and by the server-side capacity
 * alerts.
 *
 * Inputs:
 *   - physical occupancy: the validated ICU Handover Hub roster
 *     (bed slots + unassigned active patients)
 *   - per-patient acuity: CCC `patient_acuity_overrides` (L0–3 + 1:1)
 *   - nurses available for the current shift: CCC `nurse_staffing`
 *
 * Nurse weights are the existing ones in `nurse-capacity.ts`
 * (1:1 = 1, L3 = 1, L2 = 0.5, L1/L0 = 0.25). Patients with no acuity score
 * keep the existing bed-board default of L1 weighting and are counted in
 * `unscored_count` so the UI can say so.
 *
 * Safety rules:
 *   - Physical vacancies and nursing slots are reported separately.
 *   - "No nurse count recorded" is distinct from "0 nurses".
 *   - If any occupied bed has its details withheld, if acuity or staffing
 *     could not be loaded, or the roster itself is unavailable, nursing
 *     capacity is UNKNOWN — never zero-demand, never guessed.
 *   - Only a determinate, current result may drive alerts or green
 *     "room to admit" styling.
 */

import type { PartnerBedBoardOk } from "./partner-bed-board-contract";
import {
  admissionSlots,
  computeDependency,
  type AdmitCapacity,
} from "./nurse-capacity";
import type { Occupancy } from "./bed-capacity";
import type { ShiftKey } from "./shift-clock";

/** Default level used for patients without an acuity score (existing behaviour). */
export const UNSCORED_DEFAULT_LEVEL = 1;
/** Partner data older than this is "not current", even without a fetch error. */
export const STALE_AFTER_MS = 60_000;
/** Shared polling cadence for every capacity surface. */
export const CAPACITY_REFRESH_MS = 20_000;

export type AcuityRow = { partner_patient_id: string; level: number; one_to_one: boolean };

export type LoadState<T> =
  | { status: "ok"; value: T }
  | { status: "loading" }
  | { status: "error"; message?: string };

export type PhysicalCapacity = {
  total: number;
  occupied: number;
  vacant: number;
  /** Occupied beds whose occupant details the Hub withheld. */
  withheld: number;
  /** Active patients with no bed assigned (still need nursing). */
  unassigned: number;
  side_rooms_vacant: number;
};

export type NursingDemand = {
  dependency: number;
  patient_count: number;
  one_to_one_count: number;
  one_to_one_dependency: number;
  level_weighted_dependency: number;
  unscored_count: number;
};

export type UnknownReason =
  | "loading"
  | "board_unavailable"
  | "withheld"
  | "acuity_unavailable"
  | "staffing_unavailable";

export type NursingCapacity =
  | ({ state: "ok"; available: number; spare: number } & NursingDemand & AdmitCapacity)
  | ({ state: "no_staffing" } & NursingDemand)
  | { state: "unknown"; reason: UnknownReason; message: string };

export type CapacityDerivation = {
  physical: PhysicalCapacity | null;
  nursing: NursingCapacity;
  /** True only when every input is present and trustworthy. */
  determinate: boolean;
};

const UNKNOWN_MESSAGE: Record<UnknownReason, string> = {
  loading: "Loading capacity…",
  board_unavailable: "Bed occupancy unavailable from ICU Handover Hub",
  withheld: "Some occupied beds have patient details withheld — nursing demand unknown",
  acuity_unavailable: "Patient acuity could not be loaded — nursing demand unknown",
  staffing_unavailable: "Nurse staffing could not be loaded — nursing capacity unknown",
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function physicalFrom(board: PartnerBedBoardOk): PhysicalCapacity {
  const total = board.bed_board.length;
  const occupied = board.bed_board.filter((b) => b.occupied).length;
  return {
    total,
    occupied,
    vacant: total - occupied,
    withheld: board.bed_board.filter((b) => b.occupied && !b.occupant).length,
    unassigned: board.unassigned.length,
    side_rooms_vacant: board.bed_board.filter((b) => b.is_side_room && !b.occupied).length,
  };
}

export function nursingDemandFrom(
  board: PartnerBedBoardOk,
  acuity: ReadonlyArray<AcuityRow>,
): NursingDemand {
  const byId = new Map(acuity.map((a) => [a.partner_patient_id, a]));
  const patients = [
    ...board.bed_board.flatMap((b) => (b.occupied && b.occupant ? [b.occupant] : [])),
    ...board.unassigned,
  ];
  let unscored = 0;
  const occs: Occupancy[] = patients.map((p) => {
    const a = byId.get(p.id);
    const valid = a && [0, 1, 2, 3].includes(Number(a.level));
    if (!valid) unscored += 1;
    return {
      id: p.id,
      bed_id: p.bed ?? p.id,
      discharged_at: null,
      predicted_discharge_at: null,
      level: valid ? Number(a!.level) : UNSCORED_DEFAULT_LEVEL,
      one_to_one: a?.one_to_one === true,
    };
  });
  return { ...computeDependency(occs), unscored_count: unscored };
}

const unknown = (reason: UnknownReason): NursingCapacity => ({
  state: "unknown",
  reason,
  message: UNKNOWN_MESSAGE[reason],
});

export function deriveUnitCapacity(input: {
  board: LoadState<PartnerBedBoardOk>;
  acuity: LoadState<ReadonlyArray<AcuityRow>>;
  /** Nurses available for the current shift; `null` = no count recorded. */
  staffing: LoadState<number | null>;
}): CapacityDerivation {
  const { board, acuity, staffing } = input;
  if (board.status !== "ok") {
    return {
      physical: null,
      nursing: unknown(board.status === "loading" ? "loading" : "board_unavailable"),
      determinate: false,
    };
  }
  const physical = physicalFrom(board.value);
  if (physical.withheld > 0) {
    return { physical, nursing: unknown("withheld"), determinate: false };
  }
  if (acuity.status !== "ok") {
    return {
      physical,
      nursing: unknown(acuity.status === "loading" ? "loading" : "acuity_unavailable"),
      determinate: false,
    };
  }
  if (staffing.status !== "ok") {
    return {
      physical,
      nursing: unknown(staffing.status === "loading" ? "loading" : "staffing_unavailable"),
      determinate: false,
    };
  }
  const demand = nursingDemandFrom(board.value, acuity.value);
  const available = staffing.value;
  if (available == null || !Number.isFinite(available)) {
    return { physical, nursing: { state: "no_staffing", ...demand }, determinate: false };
  }
  const spare = round2(available - demand.dependency);
  return {
    physical,
    nursing: { state: "ok", available, spare, ...demand, ...admissionSlots(spare) },
    determinate: true,
  };
}

export type Freshness = "current" | "stale" | "none";

export function freshnessOf(input: {
  lastSuccessAt: string | null;
  latestFailed: boolean;
  now: number;
}): Freshness {
  if (!input.lastSuccessAt) return "none";
  const t = Date.parse(input.lastSuccessAt);
  if (!Number.isFinite(t)) return "none";
  if (input.latestFailed) return "stale";
  return input.now - t > STALE_AFTER_MS ? "stale" : "current";
}

/** Pick the staffing row for a shift; distinguishes "no row" (null) from 0. */
export function availableNursesFor(
  rows: ReadonlyArray<{ shift: string; available_nurses: number | string | null }>,
  shift: ShiftKey["shift"],
): number | null {
  const row = rows.find((r) => r.shift === shift);
  if (!row || row.available_nurses === null || row.available_nurses === undefined) return null;
  const n = Number(row.available_nurses);
  return Number.isFinite(n) ? n : null;
}

/** Can this view be shown as "room to admit" (green / reassuring)? */
export function isReassuring(d: CapacityDerivation, freshness: Freshness): boolean {
  return d.determinate && freshness === "current";
}
