import { describe, it, expect } from "vitest";
import { mapPartnerPayload } from "./partner-bed-board-contract";

const AT = "2026-07-10T09:00:00.000Z";
const occ = (id: string, bed: string | null = null) => ({ id, bed });
const slot = (bed: string, occupied: boolean, occupant: unknown = null) => ({
  bed,
  is_side_room: false,
  occupied,
  occupant,
});

function rejected(payload: unknown): string {
  const r = mapPartnerPayload({ unit_code: "SDH-RADNOR", ...(payload as object) }, AT);
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("expected failure");
  expect(r.indeterminate).toBe(true);
  return r.error;
}

describe("partner bed board contract validation", () => {
  it("accepts an older valid payload without stats/unassigned", () => {
    const r = mapPartnerPayload({ unit_code: "SDH-RADNOR", unit: "U", bed_board: [slot("1", false), slot("2", true, occ("a", "2"))] }, AT);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stats).toEqual({ total_beds: 2, occupied: 1, available: 1, unassigned: 0 });
  });

  it("rejects Hub failure (ok:false) and explicit indeterminate markers", () => {
    // Fixed text: the upstream error body is never echoed to clients.
    expect(rejected({ ok: false, error: "roster query failed" })).toBe("ICU Handover Hub reported an error");
    expect(rejected({ indeterminate: true, bed_board: [] })).toMatch(/indeterminate/);
    expect(rejected({ bed_board: [], stats: { indeterminate: true } })).toMatch(/indeterminate/);
  });

  it("rejects malformed slots", () => {
    expect(rejected({ bed_board: [{ bed: "", is_side_room: false, occupied: false }] })).toMatch(/rejected/);
    expect(rejected({ bed_board: [{ bed: "1", is_side_room: "no", occupied: false }] })).toMatch(/rejected/);
    expect(rejected({ bed_board: [{ bed: "1", is_side_room: false }] })).toMatch(/rejected/);
    expect(rejected({ bed_board: [slot("1", true, { full_name: "x" })] })).toMatch(/rejected/);
  });

  it("rejects contradictions: vacant bed with occupant, duplicate beds or patients", () => {
    rejected({ bed_board: [slot("1", false, occ("a", "1"))] });
    rejected({ bed_board: [slot("1", false), slot("1", false)] });
    rejected({ bed_board: [slot("1", true, occ("a", "1")), slot("2", true, occ("a", "2"))] });
    rejected({ bed_board: [slot("1", true, occ("a", "1"))], unassigned: [occ("a")] });
  });

  it("rejects stats that disagree with the roster (partial response)", () => {
    expect(
      rejected({
        bed_board: [slot("1", true, null), slot("2", false)],
        stats: { total_beds: 2, occupied: 0, available: 2, unassigned: 0 },
      }),
    ).toMatch(/stats\.occupied/);
    rejected({ bed_board: [slot("1", false)], stats: { total_beds: -1, occupied: 0, available: 1, unassigned: 0 } });
  });

  it("does not leak upstream error text", () => {
    const err = rejected({ ok: false, error: "patient AB 1234567 " + "x".repeat(5000) });
    expect(err).not.toMatch(/AB|1234567|xxx/);
  });

  it("strict DTO: unknown occupant fields are dropped; approved fields are type-checked", () => {
    const r = mapPartnerPayload(
      {
        unit_code: "SDH-RADNOR",
        bed_board: [
          {
            bed: " 1 ",
            is_side_room: false,
            occupied: true,
            occupant: { id: "syn-1", full_name: "AB", nhs_number: "999", notes: "secret", wardable: true },
          },
        ],
      },
      new Date().toISOString(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const o = r.bed_board[0].occupant as Record<string, unknown>;
    expect(o).not.toHaveProperty("nhs_number");
    expect(o).not.toHaveProperty("notes");
    expect(o).toMatchObject({ id: "syn-1", full_name: "AB", wardable: true });
    expect(r.bed_board[0].bed).toBe("1");
  });

  it("duplicate bed keys are detected after trim + upper-case", () => {
    const err = rejected({
      unit_code: "SDH-RADNOR",
      bed_board: [
        { bed: "sr1", is_side_room: true, occupied: false, occupant: null },
        { bed: " SR1 ", is_side_room: true, occupied: false, occupant: null },
      ],
    });
    expect(err).toBe("duplicate bed in roster");
  });

  it("outlier / transfer sections carry only approved fields", () => {
    const r = mapPartnerPayload(
      {
        unit_code: "SDH-RADNOR",
        bed_board: [],
        outliers: [{ id: "o1", ward: "W1", hospital_number: "123", diagnosis: "x" }, { nope: 1 }],
        transfers_out: [{ id: "t1", status: "pending", free_text: "y" }],
      },
      new Date().toISOString(),
    );
    expect(r.ok && r.outliers).toEqual([{ id: "o1", ward: "W1" }]);
    expect(r.ok && r.transfers_out).toEqual([{ id: "t1", status: "pending" }]);
  });

  it("an out-of-scope unit_code is rejected without echoing it", () => {
    expect(rejected({ unit_code: "OTHER-UNIT-SECRET", bed_board: [] })).not.toMatch(/OTHER/);
  });
});
