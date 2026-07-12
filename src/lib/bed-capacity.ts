// Pure helpers for deriving capacity numbers from bed board data.
// No I/O — safe to import anywhere. Unit-tested.

export type BedUnit = "icu" | "hdu";

export interface Bed {
  id: string;
  code: string;
  unit: BedUnit;
  is_side_room: boolean;
  active: boolean;
  sort_order: number;
}

export interface Occupancy {
  id: string;
  bed_id: string;
  discharged_at: string | null;
  predicted_discharge_at: string | null;
  level: number;
  /** Optional flag: patient requires 1:1 nursing regardless of level of care. */
  one_to_one?: boolean;
}


export interface CapacityCounts {
  total: number;
  occupied: number;
  free: number;
  predicted_free_in_24h: number;
}

export interface CapacitySnapshot {
  icu: CapacityCounts;
  hdu: CapacityCounts;
  outliers_count: number;
  open_transfers_count: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function countsFor(
  unit: BedUnit,
  beds: Bed[],
  live: Occupancy[],
  now: number,
): CapacityCounts {
  const unitBeds = beds.filter((b) => b.active && b.unit === unit);
  const total = unitBeds.length;
  const bedIds = new Set(unitBeds.map((b) => b.id));
  const unitLive = live.filter((o) => bedIds.has(o.bed_id));
  const occupied = unitLive.length;
  const free = Math.max(0, total - occupied);
  const cutoff = now + DAY_MS;
  const willFree = unitLive.filter((o) => {
    if (!o.predicted_discharge_at) return false;
    const t = Date.parse(o.predicted_discharge_at);
    return isFinite(t) && t <= cutoff;
  }).length;
  return { total, occupied, free, predicted_free_in_24h: free + willFree };
}

export function computeCapacity(input: {
  beds: Bed[];
  occupancies: Occupancy[]; // may include discharged; we filter
  outliers_count: number;
  open_transfers_count: number;
  now?: number;
}): CapacitySnapshot {
  const now = input.now ?? Date.now();
  const live = input.occupancies.filter((o) => !o.discharged_at);
  return {
    icu: countsFor("icu", input.beds, live, now),
    hdu: countsFor("hdu", input.beds, live, now),
    outliers_count: input.outliers_count,
    open_transfers_count: input.open_transfers_count,
  };
}

export function dayOfStay(admitted_at: string, now: number = Date.now()): number {
  const t = Date.parse(admitted_at);
  if (!isFinite(t)) return 0;
  return Math.max(1, Math.floor((now - t) / DAY_MS) + 1);
}
