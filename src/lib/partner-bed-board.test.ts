import { describe, it, expect } from "vitest";
import {
  mapPartnerPayload,
  type PartnerBedBoardOk,
  type PartnerOccupant,
} from "./partner-bed-board.functions";

const FETCHED_AT = "2026-07-10T09:00:00.000Z";

function occupant(over: Partial<PartnerOccupant> = {}): PartnerOccupant {
  return {
    id: "p-1",
    full_name: "Doe, Jane",
    hospital_number: "M1234567",
    age: 62,
    status: "L3",
    bed: "1",
    admission_date: "2026-07-05T08:00:00Z",
    tep_in_place: true,
    dnacpr_decision: "For CPR",
    outstanding_tasks: "CT abdo",
    updated_at: "2026-07-10T08:59:00Z",
    ...over,
  };
}

describe("mapPartnerPayload", () => {
  it("returns ok:false when payload is null", () => {
    const r = mapPartnerPayload(null, FETCHED_AT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/bed_board/);
      expect(r.fetched_at).toBe(FETCHED_AT);
    }
  });

  it("returns ok:false when bed_board is missing or wrong type", () => {
    expect(mapPartnerPayload({ unit: "ICU" }, FETCHED_AT).ok).toBe(false);
    expect(
      mapPartnerPayload({ bed_board: "nope" }, FETCHED_AT).ok,
    ).toBe(false);
  });

  it("maps a fully-populated composite payload verbatim", () => {
    const jane = occupant();
    const john = occupant({
      id: "p-2",
      full_name: "Smith, John",
      hospital_number: "M7654321",
      age: 71,
      bed: "SR1",
      status: "L2",
      tep_in_place: false,
      dnacpr_decision: null,
    });
    const unassigned = occupant({
      id: "p-3",
      full_name: "Roe, Alex",
      bed: null,
      hospital_number: "M0000001",
      age: 40,
    });

    const payload: PartnerBedBoardOk = {
      ok: true,
      unit: "Radnor Critical Care Unit",
      side_rooms: ["SR1", "SR2"],
      bed_board: [
        { bed: "1", is_side_room: false, occupied: true, occupant: jane },
        { bed: "2", is_side_room: false, occupied: false, occupant: null },
        { bed: "SR1", is_side_room: true, occupied: true, occupant: john },
      ],
      unassigned: [unassigned],
      stats: { total_beds: 3, occupied: 2, available: 1, unassigned: 1 },
      fetched_at: "ignored",
    };

    const r = mapPartnerPayload(payload, FETCHED_AT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.unit).toBe("Radnor Critical Care Unit");
    expect(r.side_rooms).toEqual(["SR1", "SR2"]);
    expect(r.fetched_at).toBe(FETCHED_AT);

    // bed cells preserve order, side-room flag and occupancy
    expect(r.bed_board).toHaveLength(3);
    expect(r.bed_board.map((b) => b.bed)).toEqual(["1", "2", "SR1"]);
    expect(r.bed_board[0].occupied).toBe(true);
    expect(r.bed_board[1].occupied).toBe(false);
    expect(r.bed_board[1].occupant).toBeNull();
    expect(r.bed_board[2].is_side_room).toBe(true);

    // occupant fields carry through untouched
    expect(r.bed_board[0].occupant).toEqual(jane);
    expect(r.bed_board[2].occupant?.hospital_number).toBe("M7654321");
    expect(r.bed_board[2].occupant?.tep_in_place).toBe(false);

    expect(r.unassigned).toEqual([unassigned]);
    expect(r.stats).toEqual({
      total_beds: 3,
      occupied: 2,
      available: 1,
      unassigned: 1,
    });
  });

  it("derives stats from bed_board when partner omits them", () => {
    const r = mapPartnerPayload(
      {
        unit: "ICU",
        bed_board: [
          { bed: "1", is_side_room: false, occupied: true, occupant: occupant() },
          { bed: "2", is_side_room: false, occupied: true, occupant: occupant({ id: "p-2" }) },
          { bed: "3", is_side_room: false, occupied: false, occupant: null },
        ],
      },
      FETCHED_AT,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stats).toEqual({
      total_beds: 3,
      occupied: 2,
      available: 1,
      unassigned: 0,
    });
  });

  it("defaults unit, side_rooms and unassigned when partner omits them", () => {
    const r = mapPartnerPayload(
      { bed_board: [] },
      FETCHED_AT,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.unit).toBe("Radnor Critical Care Unit");
    expect(r.side_rooms).toEqual([]);
    expect(r.unassigned).toEqual([]);
    expect(r.stats).toEqual({
      total_beds: 0,
      occupied: 0,
      available: 0,
      unassigned: 0,
    });
  });

  it("preserves null occupant fields for partially-known patients", () => {
    const partial = occupant({
      full_name: null,
      age: null,
      dnacpr_decision: null,
      outstanding_tasks: null,
    });
    const r = mapPartnerPayload(
      {
        bed_board: [
          { bed: "1", is_side_room: false, occupied: true, occupant: partial },
        ],
      },
      FETCHED_AT,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bed_board[0].occupant).toEqual(partial);
  });
});
