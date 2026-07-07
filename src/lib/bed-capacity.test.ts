import { describe, it, expect } from "vitest";
import { computeCapacity, dayOfStay, type Bed, type Occupancy } from "./bed-capacity";

const now = Date.parse("2026-07-07T12:00:00Z");

function bed(id: string, unit: "icu" | "hdu"): Bed {
  return { id, code: id, unit, is_side_room: false, active: true, sort_order: 0 };
}
function occ(bed_id: string, over: Partial<Occupancy> = {}): Occupancy {
  return { id: `o-${bed_id}`, bed_id, discharged_at: null, predicted_discharge_at: null, level: 3, ...over };
}

describe("computeCapacity", () => {
  it("counts empty unit as fully free", () => {
    const beds = [bed("a", "icu"), bed("b", "icu")];
    const snap = computeCapacity({ beds, occupancies: [], outliers_count: 0, open_transfers_count: 0, now });
    expect(snap.icu).toEqual({ total: 2, occupied: 0, free: 2, predicted_free_in_24h: 2 });
    expect(snap.hdu.total).toBe(0);
  });

  it("counts full unit with no predicted discharges", () => {
    const beds = [bed("a", "icu"), bed("b", "icu")];
    const snap = computeCapacity({ beds, occupancies: [occ("a"), occ("b")], outliers_count: 0, open_transfers_count: 0, now });
    expect(snap.icu.free).toBe(0);
    expect(snap.icu.predicted_free_in_24h).toBe(0);
  });

  it("adds predicted discharges within 24h to net free", () => {
    const beds = [bed("a", "icu"), bed("b", "icu")];
    const soon = new Date(now + 6 * 3600 * 1000).toISOString();
    const later = new Date(now + 48 * 3600 * 1000).toISOString();
    const snap = computeCapacity({
      beds,
      occupancies: [occ("a", { predicted_discharge_at: soon }), occ("b", { predicted_discharge_at: later })],
      outliers_count: 0,
      open_transfers_count: 0,
      now,
    });
    expect(snap.icu.free).toBe(0);
    expect(snap.icu.predicted_free_in_24h).toBe(1);
  });

  it("ignores discharged occupancies", () => {
    const beds = [bed("a", "icu")];
    const past = new Date(now - 3600 * 1000).toISOString();
    const snap = computeCapacity({ beds, occupancies: [occ("a", { discharged_at: past })], outliers_count: 0, open_transfers_count: 0, now });
    expect(snap.icu.occupied).toBe(0);
    expect(snap.icu.free).toBe(1);
  });

  it("splits ICU and HDU independently", () => {
    const beds = [bed("i1", "icu"), bed("i2", "icu"), bed("h1", "hdu")];
    const snap = computeCapacity({ beds, occupancies: [occ("i1"), occ("h1")], outliers_count: 2, open_transfers_count: 1, now });
    expect(snap.icu.occupied).toBe(1);
    expect(snap.hdu.occupied).toBe(1);
    expect(snap.outliers_count).toBe(2);
    expect(snap.open_transfers_count).toBe(1);
  });

  it("ignores inactive beds", () => {
    const beds = [bed("a", "icu"), { ...bed("b", "icu"), active: false }];
    const snap = computeCapacity({ beds, occupancies: [], outliers_count: 0, open_transfers_count: 0, now });
    expect(snap.icu.total).toBe(1);
  });
});

describe("dayOfStay", () => {
  it("returns 1 on admission day", () => {
    expect(dayOfStay(new Date(now - 3600 * 1000).toISOString(), now)).toBe(1);
  });
  it("counts full days elapsed", () => {
    expect(dayOfStay(new Date(now - 3 * 24 * 3600 * 1000).toISOString(), now)).toBe(4);
  });
});
