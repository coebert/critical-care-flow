// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PendingReferralsColumn, type PendingPalette } from "./pending-referrals-column";
import { WardRoundList } from "./ward-round-list";
import { mapPartnerPayload, type PartnerBedBoardOk } from "@/lib/partner-bed-board-contract";
import type { Referral } from "@/lib/referrals-list-utils";

afterEach(() => cleanup());
const p = new Proxy({}, { get: () => "" }) as PendingPalette;
const NOW = new Date("2026-11-16T12:00:00Z");
const state = (o: Partial<Parameters<typeof PendingReferralsColumn>[0]["state"]> = {}) => ({
  loading: false,
  failed: false,
  lastLoadedAt: null,
  retrying: false,
  retry: vi.fn(),
  ...o,
});
const ref = { id: "r1", status: "pending", referral_received_at: "2026-11-16T11:00:00Z", hospital_number: "SYN1", referring_specialty: "Medicine", current_ward: "W1" } as unknown as Referral;

describe("TV board pending referrals", () => {
  it("loading is not 'No pending referrals'", () => {
    render(<PendingReferralsColumn rows={null} state={state({ loading: true })} now={NOW} p={p} />);
    expect(screen.getByText("Loading referrals…")).toBeTruthy();
    expect(screen.queryByText(/No pending referrals/)).toBeNull();
  });
  it("a load error with no data says so and offers retry — never 'No pending referrals'", () => {
    const s = state({ failed: true });
    render(<PendingReferralsColumn rows={null} state={s} now={NOW} p={p} />);
    expect(screen.getByText(/Referrals could not be loaded/)).toBeTruthy();
    expect(screen.queryByText(/No pending referrals/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Retry now/ }));
    expect(s.retry).toHaveBeenCalled();
  });
  it("a failed refresh keeps the last list labelled NOT current", () => {
    render(<PendingReferralsColumn rows={[ref]} state={state({ failed: true, lastLoadedAt: "2026-11-16T11:58:00Z" })} now={NOW} p={p} />);
    expect(screen.getByText(/NOT current/)).toBeTruthy();
    expect(screen.getByText("SYN1")).toBeTruthy();
  });
  it("a true empty list says 'No pending referrals'", () => {
    render(<PendingReferralsColumn rows={[]} state={state()} now={NOW} p={p} />);
    expect(screen.getByText("No pending referrals.")).toBeTruthy();
  });
});

describe("ward round list", () => {
  const board = mapPartnerPayload(
    {
      unit_code: "SDH-RADNOR",
      bed_board: [
        { bed: "2", is_side_room: false, occupied: true, occupant: null },
        { bed: "1", is_side_room: false, occupied: true, occupant: { id: "p1", full_name: "SP", hospital_number: "SYN1", age: 50 } },
        { bed: "3", is_side_room: false, occupied: false, occupant: null },
      ],
    },
    NOW.toISOString(),
  ) as PartnerBedBoardOk;
  const cap = (o = {}) => ({ board, freshness: "current" as const, latestFailure: null, lastSuccessAt: NOW.toISOString(), now: NOW, ...o });

  it("prints nothing as current when the Hub snapshot failed", () => {
    render(
      <WardRoundList
        capacity={cap({ board: null, freshness: "none", latestFailure: { ok: false, error: "down", fetched_at: NOW.toISOString(), partner_outage: true } })}
        acuity={{ status: "success", data: [] }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/cannot be produced/);
    expect(screen.queryByRole("table")).toBeNull();
  });
  it("lists occupied beds from the Hub snapshot, withheld rows included, levels from CCC (no invented L1)", () => {
    render(<WardRoundList capacity={cap()} acuity={{ status: "success", data: [{ partner_patient_id: "p1", level: null, one_to_one: true, updated_at: "", updated_by: null }] }} />);
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(3); // header + 2 occupied
    expect(rows[1].textContent).toContain("SP");
    expect(rows[1].textContent).toContain("L?");
    expect(rows[1].textContent).toContain("1:1");
    expect(rows[2].textContent).toMatch(/details withheld/);
  });
  it("a stale snapshot is printed with an explicit NOT CURRENT age", () => {
    render(<WardRoundList capacity={cap({ freshness: "stale" })} acuity={{ status: "success", data: [] }} />);
    expect(screen.getByRole("alert").textContent).toMatch(/NOT CURRENT — Hub snapshot from/);
  });
});
