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
 * (1:1 = 1, L3 = 1, L2 = 0.5, L1/L0 = 0.25). A missing level is NOT an
 * observed L1: if any active patient has neither a recorded level nor a
 * 1:1 flag, nursing demand is indeterminate. A 1:1 patient's demand is
 * known (1.0) even without a level, without claiming any level.
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

import { MAX_FUTURE_SKEW_MS, sourceTimeOf, type PartnerBedBoardOk } from "./partner-bed-board-contract";
import {
  admissionSlots,
  computeDependency,
  type AdmitCapacity,
} from "./nurse-capacity";
import type { Occupancy } from "./bed-capacity";
import type { ShiftKey } from "./shift-clock";

/** Partner data older than this is "not current", even without a fetch error. */
export const STALE_AFTER_MS = 60_000;
/** Shared polling cadence for every capacity surface. */
export const CAPACITY_REFRESH_MS = 20_000;

/** `level: null` = no level observed (e.g. only 1:1 recorded). */
export type AcuityRow = { partner_patient_id: string; level: number | null; one_to_one: boolean };

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
  /** ALL active patients with no bed assigned (Hub stats; still need nursing). */
  unassigned: number;
  /** Of those, how many the Hub did not disclose. */
  hidden_unassigned: number;
  side_rooms_vacant: number;
};

export type NursingDemand = {
  dependency: number;
  patient_count: number;
  one_to_one_count: number;
  one_to_one_dependency: number;
  level_weighted_dependency: number;
  /** Active disclosed patients with neither a recorded level nor 1:1. */
  unscored_count: number;
};

export type UnknownReason =
  | "loading"
  | "board_unavailable"
  | "withheld"
  | "unassigned_withheld"
  | "acuity_missing"
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
  unassigned_withheld: "Some patients awaiting a bed are not disclosed by ICU Handover Hub — nursing demand unknown",
  acuity_missing: "Some patients have no level of care recorded — nursing demand unknown",
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
    unassigned: board.stats.unassigned,
    hidden_unassigned: board.hidden_unassigned ?? 0,
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
    const oneToOne = a?.one_to_one === true;
    const lvl = a?.level;
    const observed = lvl !== null && lvl !== undefined && [0, 1, 2, 3].includes(Number(lvl));
    // 1:1 demand is known regardless of level; otherwise a level is required.
    if (!oneToOne && !observed) unscored += 1;
    return {
      id: p.id,
      bed_id: p.bed ?? p.id,
      discharged_at: null,
      predicted_discharge_at: null,
      // Only used for non-1:1 patients with an observed level; never an
      // invented default for patients without one (they make demand unknown).
      level: observed ? Number(lvl) : (null as unknown as number),
      one_to_one: oneToOne,
    };
  });
  return { ...computeDependency(occs), unscored_count: unscored };
}

const unknown = (reason: UnknownReason, message?: string): NursingCapacity => ({
  state: "unknown",
  reason,
  message: message ?? UNKNOWN_MESSAGE[reason],
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
  if (physical.hidden_unassigned > 0) {
    return { physical, nursing: unknown("unassigned_withheld"), determinate: false };
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
  if (demand.unscored_count > 0) {
    const n = demand.unscored_count;
    return {
      physical,
      nursing: unknown(
        "acuity_missing",
        `${n} patient${n === 1 ? " has" : "s have"} no level of care recorded — nursing demand unknown until scored`,
      ),
      determinate: false,
    };
  }
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

/**
 * `lastSuccessAt` must be the time the DATA describes (Hub `generated_at`
 * when present — see `boardSourceTime`), so a fresh fetch of an old Hub
 * snapshot is still "stale".
 */
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
  rows: ReadonlyArray<{ shift: string; available_nurses: number | string | null }> | null | undefined,
  shift: ShiftKey["shift"],
): number | null {
  // A malformed/empty staffing payload is "not recorded", never a crash or 0.
  if (!Array.isArray(rows)) return null;
  const row = rows.find((r) => r.shift === shift);
  if (!row || row.available_nurses === null || row.available_nurses === undefined) return null;
  const n = Number(row.available_nurses);
  return Number.isFinite(n) ? n : null;
}

/** Can this view be shown as "room to admit" (green / reassuring)? */
export function isReassuring(d: CapacityDerivation, freshness: Freshness): boolean {
  return d.determinate && freshness === "current";
}

/** Time the board describes — Hub snapshot time when sent, else fetch time. */
export function boardSourceTime(board: PartnerBedBoardOk | null | undefined): string | null {
  return board ? sourceTimeOf(board) : null;
}

// ---------------------------------------------------------------------------
// Freshness of EVERY required input (board, acuity, staffing).
// ---------------------------------------------------------------------------

export type CapacityInputName = "board" | "acuity" | "staffing";
export type InputFreshness = "current" | "stale" | "pending" | "error" | "forbidden" | "invalid_time";

export type CapacityInput = {
  /** ok = we hold a successful same-session result. */
  state: "ok" | "pending" | "error" | "forbidden";
  /** Time the held data describes (Hub generated_at / successful read time). */
  sourceAt: string | number | null;
  /** The latest refresh failed (data shown is last-known only). */
  latestFailed?: boolean;
};

export function inputFreshness(i: CapacityInput, now: number): InputFreshness {
  if (i.state === "forbidden") return "forbidden";
  if (i.state === "pending") return "pending";
  if (i.state === "error" && i.sourceAt == null) return "error";
  const t = typeof i.sourceAt === "number" ? i.sourceAt : i.sourceAt ? Date.parse(i.sourceAt) : NaN;
  if (!Number.isFinite(t) || t <= 0) return "invalid_time";
  if (t - now > MAX_FUTURE_SKEW_MS) return "invalid_time";
  if (i.latestFailed || i.state === "error") return "stale";
  return now - t > STALE_AFTER_MS ? "stale" : "current";
}

/**
 * Combined freshness: "current" only when EVERY input is current; "none"
 * when any input has no usable data; otherwise "stale" (not current).
 */
export function combinedFreshness(
  inputs: Record<CapacityInputName, CapacityInput>,
  now: number,
): { freshness: Freshness; inputs: Record<CapacityInputName, InputFreshness> } {
  const each = {
    board: inputFreshness(inputs.board, now),
    acuity: inputFreshness(inputs.acuity, now),
    staffing: inputFreshness(inputs.staffing, now),
  };
  const vals = Object.values(each);
  const freshness: Freshness = vals.every((v) => v === "current")
    ? "current"
    : vals.some((v) => v === "pending" || v === "error" || v === "forbidden" || v === "invalid_time")
      ? "none"
      : "stale";
  return { freshness, inputs: each };
}
