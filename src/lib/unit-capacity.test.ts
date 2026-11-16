import { describe, it, expect } from "vitest";
import { mapPartnerPayload, type PartnerBedBoardOk } from "./partner-bed-board-contract";
import {
  availableNursesFor,
  deriveUnitCapacity,
  freshnessOf,
  isReassuring,
  type AcuityRow,
} from "./unit-capacity";

// Synthetic data only.
const AT = "2026-07-10T09:00:00.000Z";
const occ = (id: string, bed: string | null) => ({ id, full_name: null, hospital_number: null, bed });

function board(payload: unknown): PartnerBedBoardOk {
  const r = mapPartnerPayload({ unit_code: "SDH-RADNOR", ...(payload as object) }, AT);
  if (!r.ok) throw new Error(`expected ok board, got: ${r.error}`);
  return r;
}

const ok = <T,>(value: T) => ({ status: "ok" as const, value });

describe("partner contract: occupied with withheld identity", () => {
  const withheld = {
    unit: "Radnor Critical Care Unit",
    bed_board: [
      { bed: "1", is_side_room: false, occupied: true, occupant: occ("p1", "1") },
      { bed: "2", is_side_room: false, occupied: true, occupant: null },
      { bed: "3", is_side_room: true, occupied: false, occupant: null },
    ],
  };

  it("is a valid payload and the withheld bed counts as occupied, never vacant", () => {
    const b = board(withheld);
    expect(b.stats).toEqual({ total_beds: 3, occupied: 2, available: 1, unassigned: 0 });
    const d = deriveUnitCapacity({ board: ok(b), acuity: ok([]), staffing: ok(10) });
    expect(d.physical).toMatchObject({ total: 3, occupied: 2, vacant: 1, withheld: 1 });
  });

  it("makes nursing demand unknown (no guessed acuity) and is not reassuring", () => {
    const d = deriveUnitCapacity({ board: ok(board(withheld)), acuity: ok([]), staffing: ok(10) });
    expect(d.nursing.state).toBe("unknown");
    if (d.nursing.state === "unknown") expect(d.nursing.reason).toBe("withheld");
    expect(d.determinate).toBe(false);
    expect(isReassuring(d, "current")).toBe(false);
  });
});

describe("no false vacancy", () => {
  it("partner failure gives no physical counts and unknown nursing", () => {
    const d = deriveUnitCapacity({
      board: { status: "error", message: "down" },
      acuity: ok([]),
      staffing: ok(5),
    });
    expect(d.physical).toBeNull();
    expect(d.nursing).toMatchObject({ state: "unknown", reason: "board_unavailable" });
    expect(d.determinate).toBe(false);
  });

  it("loading board is unknown, not empty", () => {
    const d = deriveUnitCapacity({ board: { status: "loading" }, acuity: ok([]), staffing: ok(5) });
    expect(d.physical).toBeNull();
    expect(d.nursing).toMatchObject({ state: "unknown", reason: "loading" });
  });

  it("acuity or staffing query error is unknown, not zero demand", () => {
    const b = board({ bed_board: [{ bed: "1", is_side_room: false, occupied: true, occupant: occ("p1", "1") }] });
    expect(deriveUnitCapacity({ board: ok(b), acuity: { status: "error" }, staffing: ok(3) }).nursing)
      .toMatchObject({ state: "unknown", reason: "acuity_unavailable" });
    expect(deriveUnitCapacity({ board: ok(b), acuity: ok([]), staffing: { status: "error" } }).nursing)
      .toMatchObject({ state: "unknown", reason: "staffing_unavailable" });
  });
});

describe("nursing calculation (existing weights)", () => {
  it("1 nurse + 1 one-to-one patient => zero spare, zero L3 slots", () => {
    const b = board({ bed_board: [{ bed: "1", is_side_room: false, occupied: true, occupant: occ("p1", "1") }] });
    const acuity: AcuityRow[] = [{ partner_patient_id: "p1", level: 2, one_to_one: true }];
    const d = deriveUnitCapacity({ board: ok(b), acuity: ok(acuity), staffing: ok(1) });
    expect(d.nursing.state).toBe("ok");
    if (d.nursing.state === "ok") {
      expect(d.nursing.dependency).toBe(1);
      expect(d.nursing.spare).toBe(0);
      expect(d.nursing.level3_slots).toBe(0);
      expect(d.nursing.level2_slots).toBe(0);
      expect(d.nursing.level1_slots).toBe(0);
    }
  });

  it("unassigned active patients are included in demand", () => {
    const b = board({
      bed_board: [{ bed: "1", is_side_room: false, occupied: false, occupant: null }],
      unassigned: [occ("u1", null)],
    });
    const d = deriveUnitCapacity({
      board: ok(b),
      acuity: ok([{ partner_patient_id: "u1", level: 3, one_to_one: false }]),
      staffing: ok(2),
    });
    expect(d.physical).toMatchObject({ vacant: 1, unassigned: 1 });
    expect(d.nursing.state).toBe("ok");
    if (d.nursing.state === "ok") {
      expect(d.nursing.patient_count).toBe(1);
      expect(d.nursing.dependency).toBe(1);
      expect(d.nursing.spare).toBe(1);
      expect(d.nursing.level3_slots).toBe(1);
    }
  });

  it("missing nurse count is distinct from a recorded zero", () => {
    const b = board({ bed_board: [{ bed: "1", is_side_room: false, occupied: true, occupant: occ("p1", "1") }] });
    expect(availableNursesFor([], "day")).toBeNull();
    expect(availableNursesFor([{ shift: "day", available_nurses: 0 }], "day")).toBe(0);
    expect(availableNursesFor([{ shift: "night", available_nurses: 4 }], "day")).toBeNull();

    const l1 = [{ partner_patient_id: "p1", level: 1, one_to_one: false }];
    const missing = deriveUnitCapacity({ board: ok(b), acuity: ok(l1), staffing: ok(null) });
    expect(missing.nursing.state).toBe("no_staffing");
    expect(missing.determinate).toBe(false);

    const zero = deriveUnitCapacity({ board: ok(b), acuity: ok(l1), staffing: ok(0) });
    expect(zero.nursing.state).toBe("ok");
    if (zero.nursing.state === "ok") {
      expect(zero.nursing.available).toBe(0);
      expect(zero.nursing.spare).toBe(-0.25);
      expect(zero.nursing.level1_slots).toBe(0);
    }
  });
});

describe("freshness and recovery", () => {
  const now = Date.parse("2026-07-10T09:00:30.000Z");
  it("current when the last success is recent and the latest fetch succeeded", () => {
    expect(freshnessOf({ lastSuccessAt: AT, latestFailed: false, now })).toBe("current");
  });
  it("stale when the latest refresh failed, even if recent", () => {
    expect(freshnessOf({ lastSuccessAt: AT, latestFailed: true, now })).toBe("stale");
  });
  it("stale after 60s without a successful refresh", () => {
    expect(freshnessOf({ lastSuccessAt: AT, latestFailed: false, now: now + 60_000 })).toBe("stale");
  });
  it("none when nothing has ever loaded", () => {
    expect(freshnessOf({ lastSuccessAt: null, latestFailed: true, now })).toBe("none");
  });
  it("a determinate last-known view is NOT reassuring once stale, and recovers when current", () => {
    const b = board({ bed_board: [{ bed: "1", is_side_room: false, occupied: false, occupant: null }] });
    const d = deriveUnitCapacity({ board: ok(b), acuity: ok([]), staffing: ok(3) });
    expect(d.determinate).toBe(true);
    expect(isReassuring(d, "stale")).toBe(false);
    expect(isReassuring(d, "current")).toBe(true);
  });
});
