// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// --- Mocks: synthetic data only, no network, no mutations ---------------
const board = vi.fn();
const acuity = vi.fn();
const staffing = vi.fn();
vi.mock("@/lib/partner-bed-board.functions", () => ({ getPartnerBedBoard: () => board() }));
vi.mock("@/lib/patient-acuity.functions", () => ({ getPatientAcuity: () => acuity() }));
vi.mock("@/lib/nurse-staffing.functions", () => ({
  getNurseStaffingForDate: (a: unknown) => staffing(a),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, search: _s, ...rest }: { children: ReactNode; to: string; search?: unknown }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

import { CapacityBadge } from "@/components/referrals/capacity-badge";
import { AdmissionCapacityCallout } from "@/components/referrals/admission-capacity-callout";
import { MiniCapacityLink } from "@/components/bed-board/mini-capacity-link";
import { mapPartnerPayload } from "@/lib/partner-bed-board-contract";

const okBoard = (beds: unknown[]) => mapPartnerPayload({ unit: "Synthetic Unit", bed_board: beds }, new Date().toISOString());
const slot = (bed: string, occupant: unknown, occupied = occupant != null) => ({ bed, is_side_room: false, occupied, occupant });

function renderAll() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <div data-testid="badge"><CapacityBadge /></div>
      <div data-testid="mini"><MiniCapacityLink /></div>
      <div data-testid="callout"><AdmissionCapacityCallout /></div>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  board.mockReset();
  acuity.mockReset();
  staffing.mockReset();
  acuity.mockResolvedValue([{ partner_patient_id: "syn-1", level: 3, one_to_one: false }]);
  staffing.mockResolvedValue([
    { shift: "day", available_nurses: 2 },
    { shift: "night", available_nurses: 2 },
  ]);
});
afterEach(() => cleanup());

describe("capacity surfaces share one calculation", () => {
  it("badge, mini link and callout show the same beds and nursing room, with one board fetch", async () => {
    board.mockResolvedValue(okBoard([slot("1", { id: "syn-1", bed: "1" }), slot("2", null), slot("3", null)]));
    renderAll();
    await waitFor(() => expect(screen.getByTestId("badge").textContent).toMatch(/Beds free\s*2\/3/));
    expect(screen.getByTestId("mini").textContent).toMatch(/2\/3 free/);
    expect(screen.getByTestId("callout").textContent).toMatch(/Beds free\s*2\s*of 3/);
    // 2 nurses − 1 L3 patient = 1 spare → 1 L3 slot, everywhere.
    expect(screen.getByTestId("badge").textContent).toMatch(/L3\s*1/);
    expect(screen.getByTestId("callout").textContent).toMatch(/Nursing room for\s*1\s*L3/);
    expect(board).toHaveBeenCalledTimes(1);
  });

  it("occupied bed with withheld details is occupied everywhere and nursing room is unknown", async () => {
    board.mockResolvedValue(okBoard([slot("1", null, true), slot("2", null)]));
    renderAll();
    await waitFor(() => expect(screen.getByTestId("badge").textContent).toMatch(/Beds free\s*1\/2/));
    expect(screen.getByTestId("mini").textContent).toMatch(/1\/2 free/);
    expect(screen.getByTestId("mini").textContent).toMatch(/details withheld/);
    expect(screen.getByTestId("badge").textContent).toMatch(/Nursing room unknown/);
    expect(screen.getByTestId("callout").textContent).toMatch(/withheld/);
    expect(screen.getByTestId("callout").textContent).not.toMatch(/Nursing room for/);
  });

  it("partner failure shows no counts, then recovers on refresh", async () => {
    board.mockResolvedValue({ ok: false, error: "down", fetched_at: new Date().toISOString(), partner_outage: true });
    renderAll();
    await waitFor(() => expect(screen.getByTestId("callout").textContent).toMatch(/ICU Handover Hub is unavailable/));
    expect(screen.queryByText(/Beds free/)).toBeNull();
    expect(screen.getByTestId("mini").textContent).toMatch(/occupancy unavailable/);

    board.mockResolvedValue(okBoard([slot("1", null), slot("2", null)]));
    fireEvent.click(screen.getAllByRole("button", { name: /Refresh capacity now/ })[0]);
    await waitFor(() => expect(screen.getByTestId("badge").textContent).toMatch(/Beds free\s*2\/2/));
    expect(screen.getByTestId("callout").textContent).toMatch(/Live/);
  });

  it("missing nurse count says so instead of showing zero", async () => {
    board.mockResolvedValue(okBoard([slot("1", { id: "syn-1", bed: "1" }), slot("2", null)]));
    staffing.mockResolvedValue([]);
    renderAll();
    await waitFor(() => expect(screen.getByTestId("badge").textContent).toMatch(/No nurse count/));
    expect(screen.getByTestId("callout").textContent).toMatch(/No nurse count recorded/);
  });
});
