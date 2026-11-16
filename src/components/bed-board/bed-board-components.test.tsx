// @vitest-environment jsdom
/**
 * Bed card state changes (Rules of Hooks), discharge-timing wording, Hub
 * mismatch notice, and the nurse staffing editor. Synthetic data only;
 * every server call is a local mock.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const upsert = vi.fn();
const staffingRows = vi.fn();
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/nurse-staffing.functions", () => ({
  upsertNurseStaffing: (a: unknown) => upsert(a),
  getNurseStaffingForDate: (a: unknown) => staffingRows(a),
}));
vi.mock("@/lib/partner-bed-board.functions", () => ({ getPartnerBedBoard: async () => ({}) }));
vi.mock("@/lib/patient-acuity.functions", () => ({ getPatientAcuity: async () => [] }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { BedCard, type BedCardProps } from "./bed-card";
import { NurseCapacityPanel } from "./nurse-capacity-panel";
import { deriveUnitCapacity } from "@/lib/unit-capacity";
import { mapPartnerPayload, type PartnerBedBoardOk, type PartnerBedSlot } from "@/lib/partner-bed-board-contract";
import { currentShift } from "@/lib/shift-clock";
import type { UnitCapacityView } from "@/hooks/use-unit-capacity";

afterEach(() => cleanup());

const noop = () => undefined;
const baseProps = (slot: PartnerBedSlot): BedCardProps => ({
  slot,
  level: 2,
  oneToOne: false,
  hasTracheostomy: false,
  isolation: null,
  isolationReason: null,
  isolationPending: false,
  onCycleIsolation: noop,
  violenceRisk: false,
  violencePending: false,
  onToggleViolenceRisk: noop,
  endOfLife: false,
  endOfLifePending: false,
  onToggleEndOfLife: noop,
  needsScanTransfer: false,
  scanTransferPending: false,
  onToggleScanTransfer: noop,
  wardable: false,
  wardableAt: null,
  dischargedAt: null,
  wardablePending: false,
  dischargePending: false,
  onToggleWardable: noop,
  onDischarge: noop,
  onOccupiedClick: noop,
  onMove: noop,
  isDragTarget: false,
  onDragStateChange: noop,
});
const occ = { id: "syn-1", full_name: "SP", hospital_number: "SYN1", age: 50, status: null, bed: "1", admission_date: null, tep_in_place: false, dnacpr_decision: false, outstanding_tasks: null, updated_at: "2026-11-16T10:00:00Z" };
const empty: PartnerBedSlot = { bed: "1", is_side_room: false, occupied: false, occupant: null };
const occupied: PartnerBedSlot = { bed: "1", is_side_room: false, occupied: true, occupant: occ };
const withheld: PartnerBedSlot = { bed: "1", is_side_room: false, occupied: true, occupant: null };

describe("BedCard", () => {
  it("the same mounted bed can switch empty ↔ occupied ↔ withheld with no React errors", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { rerender, container } = render(<BedCard key="1" {...baseProps(empty)} />);
    for (const s of [occupied, withheld, occupied, empty, withheld, empty, occupied]) {
      rerender(<BedCard key="1" {...baseProps(s)} />);
    }
    expect(errors).not.toHaveBeenCalled();
    expect(container.textContent).toContain("SP");
    rerender(<BedCard key="1" {...baseProps(withheld)} />);
    expect(screen.getByLabelText(/occupied — patient details withheld/i)).toBeTruthy();
    errors.mockRestore();
  });

  it("discharge is labelled as local timing; the bed stays occupied; Hub link and mismatch retry are offered", () => {
    const retry = vi.fn();
    render(
      <BedCard
        {...baseProps(occupied)}
        dischargedAt="2026-11-16T11:00:00Z"
        hubPatientUrl="https://hub.synthetic.test/patients/syn-1"
        hubSync={{ mismatch: true, reason: "failed" }}
        onRetryHubSync={retry}
      />,
    );
    expect(screen.getByText(/Discharge time recorded here/)).toBeTruthy();
    expect(screen.getByLabelText(/Bed 1 — SP/)).toBeTruthy(); // still an occupied card
    const link = screen.getByRole("link", { name: /ICU Handover Hub to discharge/ }) as HTMLAnchorElement;
    expect(link.href).toBe("https://hub.synthetic.test/patients/syn-1");
    expect(screen.getByText(/Hub not updated · wardable saved here/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Retry updating ICU Handover Hub/ }));
    expect(retry).toHaveBeenCalledWith("syn-1");
  });

  it("an unrecorded discharge offers 'Record discharge timing', never 'Discharge'", () => {
    render(<BedCard {...baseProps(occupied)} />);
    expect(screen.getByRole("button", { name: /Record discharge timing/ })).toBeTruthy();
  });
});

function view(): UnitCapacityView {
  const board = mapPartnerPayload({ unit_code: "SDH-RADNOR", bed_board: [] }, new Date().toISOString()) as PartnerBedBoardOk;
  const derivation = deriveUnitCapacity({ board: { status: "ok", value: board }, acuity: { status: "ok", value: [] }, staffing: { status: "ok", value: null } });
  return {
    shift: currentShift(new Date()),
    derivation,
    freshness: "current",
    reassuring: false,
    lastSuccessAt: board.fetched_at,
    latestFailure: null,
    board,
    isLoading: false,
    isFetching: false,
    refresh: noop,
    now: new Date(),
  };
}

describe("nurse staffing editor", () => {
  beforeEach(() => {
    upsert.mockReset();
    staffingRows.mockReset();
    staffingRows.mockResolvedValue([]); // no count recorded → editor opens
  });
  const renderPanel = () =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <NurseCapacityPanel view={view()} />
      </QueryClientProvider>,
    );

  it("a blank box is refused and never saved as zero", async () => {
    renderPanel();
    const save = (await screen.findAllByRole("button", { name: /Save .* shift nurse count/ }))[0];
    fireEvent.click(save);
    expect(await screen.findByText(/A blank box is not saved/)).toBeTruthy();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("zero is saved as a real zero", async () => {
    upsert.mockResolvedValue({});
    renderPanel();
    const input = (await screen.findAllByRole("spinbutton"))[0];
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.click(screen.getAllByRole("button", { name: /Save .* shift nurse count/ })[0]);
    await waitFor(() => expect(upsert).toHaveBeenCalledTimes(1));
    expect(upsert.mock.calls[0][0]).toMatchObject({ data: { available_nurses: 0 } });
  });

  it("a failed save keeps the typed number and shows an error; cancel is labelled", async () => {
    upsert.mockRejectedValue(new Error("synthetic outage"));
    renderPanel();
    const input = (await screen.findAllByRole("spinbutton"))[0] as HTMLInputElement;
    fireEvent.change(input, { target: { value: "4" } });
    fireEvent.click(screen.getAllByRole("button", { name: /Save .* shift nurse count/ })[0]);
    expect(await screen.findByText(/Not saved — your number is kept here/)).toBeTruthy();
    expect(((await screen.findAllByRole("spinbutton"))[0] as HTMLInputElement).value).toBe("4");
    expect(screen.getAllByRole("button", { name: /Cancel editing (day|night) shift nurse count/ }).length).toBeGreaterThan(0);
  });
});
