/**
 * Client-safe contract for the ICU Handover Hub `/bridge/beds` composite
 * payload, plus a strict validator/normaliser.
 *
 * Contract (additive, backwards compatible):
 *   - Each bed slot is `{ bed, is_side_room, occupied, occupant }`.
 *   - `occupied: true, occupant: null` means the bed IS occupied but the
 *     patient details are withheld. It must render as occupied — never as a
 *     vacancy — and nursing demand for it is unknown.
 *   - The Hub may explicitly fail (`ok: false`) or flag the board as
 *     indeterminate (`indeterminate: true`, or `stats.indeterminate: true`)
 *     when its roster query fails or assignments are duplicated.
 *   - Older payloads without `stats`/`unassigned`/`side_rooms` remain valid.
 *
 * Anything else that is malformed or partial (wrong types, duplicate beds,
 * the same patient in two places, stats that disagree with the roster) is
 * rejected rather than shown, so a broken response can never surface as a
 * reassuring "beds available" count.
 */

/** Serializable passthrough payload (opaque to this app). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

export type PartnerOccupant = {
  id: string;
  full_name: string | null;
  hospital_number: string | null;
  age: number | null;
  status: string | null;
  bed: string | null;
  admission_date: string | null;
  tep_in_place: boolean | null;
  dnacpr_decision: boolean | null;
  dnacpr_details?: string | null;
  tep_details?: string | null;
  outstanding_tasks: string | null;
  updated_at: string | null;
};

export type PartnerBedSlot = {
  bed: string;
  is_side_room: boolean;
  occupied: boolean;
  /** null when vacant OR when the Hub withholds the occupant's details. */
  occupant: PartnerOccupant | null;
};

export type PartnerBedBoardStats = {
  total_beds: number;
  occupied: number;
  available: number;
  unassigned: number;
};

export type PartnerBedBoardOk = {
  ok: true;
  unit: string;
  side_rooms: string[];
  bed_board: PartnerBedSlot[];
  unassigned: PartnerOccupant[];
  stats: PartnerBedBoardStats;
  fetched_at: string;
  /** Optional additive sections passed through untouched when they are arrays. */
  outliers?: JsonValue[];
  transfers_out?: JsonValue[];
};

export type PartnerBedBoardFailure = {
  ok: false;
  error: string;
  fetched_at: string;
  partner_outage?: boolean;
  status?: number;
  /** The Hub (or our validator) could not establish a trustworthy roster. */
  indeterminate?: boolean;
  /** The caller is not allowed to read the board. */
  forbidden?: boolean;
};

export type PartnerBedBoardResult = PartnerBedBoardOk | PartnerBedBoardFailure;

export const DEFAULT_UNIT_NAME = "Radnor Critical Care Unit";

class ContractError extends Error {
  constructor(
    message: string,
    public readonly indeterminate = false,
  ) {
    super(message);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function optString(o: Record<string, unknown>, k: string, where: string) {
  const v = o[k];
  if (v === undefined || v === null || typeof v === "string") return;
  throw new ContractError(`${where}.${k} must be a string or null`);
}
function optNumber(o: Record<string, unknown>, k: string, where: string) {
  const v = o[k];
  if (v === undefined || v === null || (typeof v === "number" && Number.isFinite(v))) return;
  throw new ContractError(`${where}.${k} must be a number or null`);
}
function optBool(o: Record<string, unknown>, k: string, where: string) {
  const v = o[k];
  if (v === undefined || v === null || typeof v === "boolean") return;
  throw new ContractError(`${where}.${k} must be a boolean or null`);
}

function validateOccupant(v: unknown, where: string): PartnerOccupant {
  if (!isObj(v)) throw new ContractError(`${where} must be an object`);
  if (typeof v.id !== "string" || v.id.trim() === "") {
    throw new ContractError(`${where}.id is required`);
  }
  for (const k of [
    "full_name",
    "hospital_number",
    "status",
    "bed",
    "admission_date",
    "dnacpr_details",
    "tep_details",
    "outstanding_tasks",
    "updated_at",
  ]) {
    optString(v, k, where);
  }
  optNumber(v, "age", where);
  optBool(v, "tep_in_place", where);
  optBool(v, "dnacpr_decision", where);
  return {
    full_name: null,
    hospital_number: null,
    age: null,
    status: null,
    bed: null,
    admission_date: null,
    tep_in_place: null,
    dnacpr_decision: null,
    outstanding_tasks: null,
    updated_at: null,
    ...(v as Partial<PartnerOccupant>),
    id: v.id,
  };
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function safeMessage(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : fallback;
}

function validate(payload: unknown, fetchedAt: string): PartnerBedBoardResult {
  if (!isObj(payload)) throw new ContractError("partner payload missing bed_board array");

  // Explicit failure / indeterminate signals from the Hub.
  if (payload.ok === false) {
    return {
      ok: false,
      error: safeMessage(payload.error ?? payload.message, "ICU Handover Hub reported an error"),
      fetched_at: fetchedAt,
      indeterminate: true,
    };
  }
  const statsRaw = payload.stats;
  if (
    payload.indeterminate === true ||
    (isObj(statsRaw) && statsRaw.indeterminate === true)
  ) {
    throw new ContractError(
      "ICU Handover Hub could not confirm bed occupancy (indeterminate roster)",
      true,
    );
  }

  if (!Array.isArray(payload.bed_board)) {
    throw new ContractError("partner payload missing bed_board array");
  }

  const seenBeds = new Set<string>();
  const seenPatients = new Set<string>();
  const bedBoard: PartnerBedSlot[] = payload.bed_board.map((raw, i) => {
    const where = `bed_board[${i}]`;
    if (!isObj(raw)) throw new ContractError(`${where} must be an object`);
    if (typeof raw.bed !== "string" || raw.bed.trim() === "") {
      throw new ContractError(`${where}.bed is required`);
    }
    if (typeof raw.is_side_room !== "boolean") {
      throw new ContractError(`${where}.is_side_room must be a boolean`);
    }
    if (typeof raw.occupied !== "boolean") {
      throw new ContractError(`${where}.occupied must be a boolean`);
    }
    if (seenBeds.has(raw.bed)) {
      throw new ContractError(`duplicate bed ${raw.bed} in roster`, true);
    }
    seenBeds.add(raw.bed);
    const hasOccupant = raw.occupant !== undefined && raw.occupant !== null;
    if (!raw.occupied && hasOccupant) {
      throw new ContractError(`${where} is marked vacant but has an occupant`, true);
    }
    const occupant = hasOccupant ? validateOccupant(raw.occupant, `${where}.occupant`) : null;
    if (occupant) {
      if (seenPatients.has(occupant.id)) {
        throw new ContractError("the same patient is assigned to more than one bed", true);
      }
      seenPatients.add(occupant.id);
    }
    return { bed: raw.bed, is_side_room: raw.is_side_room, occupied: raw.occupied, occupant };
  });

  let unassigned: PartnerOccupant[] = [];
  if (payload.unassigned !== undefined && payload.unassigned !== null) {
    if (!Array.isArray(payload.unassigned)) {
      throw new ContractError("unassigned must be an array");
    }
    unassigned = payload.unassigned.map((u, i) => {
      const o = validateOccupant(u, `unassigned[${i}]`);
      if (seenPatients.has(o.id)) {
        throw new ContractError("a patient is listed both in a bed and as unassigned", true);
      }
      seenPatients.add(o.id);
      return o;
    });
  }

  let sideRooms: string[] = [];
  if (payload.side_rooms !== undefined && payload.side_rooms !== null) {
    if (!Array.isArray(payload.side_rooms) || !payload.side_rooms.every((s) => typeof s === "string")) {
      throw new ContractError("side_rooms must be an array of strings");
    }
    sideRooms = payload.side_rooms as string[];
  }

  const occupiedCount = bedBoard.filter((b) => b.occupied).length;
  const derived: PartnerBedBoardStats = {
    total_beds: bedBoard.length,
    occupied: occupiedCount,
    available: bedBoard.length - occupiedCount,
    unassigned: unassigned.length,
  };

  if (statsRaw !== undefined && statsRaw !== null) {
    if (!isObj(statsRaw)) throw new ContractError("stats must be an object");
    for (const k of ["total_beds", "occupied", "available", "unassigned"] as const) {
      if (!isCount(statsRaw[k])) throw new ContractError(`stats.${k} must be a non-negative integer`);
      if (statsRaw[k] !== derived[k]) {
        throw new ContractError(`stats.${k} (${statsRaw[k]}) disagrees with the roster (${derived[k]})`);
      }
    }
  }

  const out: PartnerBedBoardOk = {
    ok: true,
    unit: typeof payload.unit === "string" && payload.unit.trim() ? payload.unit : DEFAULT_UNIT_NAME,
    side_rooms: sideRooms,
    bed_board: bedBoard,
    unassigned,
    stats: derived,
    fetched_at: fetchedAt,
  };
  if (Array.isArray(payload.outliers)) out.outliers = payload.outliers as JsonValue[];
  if (Array.isArray(payload.transfers_out)) out.transfers_out = payload.transfers_out as JsonValue[];
  return out;
}

/**
 * Validate + normalise a raw `/bridge/beds` JSON body. Never throws.
 * Successful results always carry `stats` derived from (and checked against)
 * the roster itself.
 */
export function mapPartnerPayload(payload: unknown, fetchedAt: string): PartnerBedBoardResult {
  try {
    return validate(payload, fetchedAt);
  } catch (e) {
    if (e instanceof ContractError) {
      return {
        ok: false,
        error: e.indeterminate ? e.message : `partner payload rejected: ${e.message}`,
        fetched_at: fetchedAt,
        indeterminate: true,
      };
    }
    return { ok: false, error: "partner payload rejected", fetched_at: fetchedAt, indeterminate: true };
  }
}

/** Number of occupied beds whose occupant details were withheld by the Hub. */
export function withheldCount(board: Pick<PartnerBedBoardOk, "bed_board">): number {
  return board.bed_board.filter((b) => b.occupied && !b.occupant).length;
}
