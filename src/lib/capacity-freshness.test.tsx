// @vitest-environment jsdom
/**
 * Every required capacity input is aged — board, acuity AND staffing.
 * Synthetic data, mocked server functions, no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";

const board = vi.fn();
const acuity = vi.fn();
const staffing = vi.fn();
vi.mock("@/lib/partner-bed-board.functions", () => ({ getPartnerBedBoard: () => board() }));
vi.mock("@/lib/patient-acuity.functions", () => ({ getPatientAcuity: () => acuity() }));
vi.mock("@/lib/nurse-staffing.functions", () => ({ getNurseStaffingForDate: (a: unknown) => staffing(a) }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));

import { combinedFreshness, inputFreshness, STALE_AFTER_MS } from "./unit-capacity";
import { useUnitCapacity, ACUITY_QK } from "@/hooks/use-unit-capacity";
import { mapPartnerPayload } from "./partner-bed-board-contract";
import { __resetSessionScopeForTests } from "./session-scope";

const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const ok = (at: number) => ({ state: "ok" as const, sourceAt: at });

describe("input freshness rules", () => {
  it("fresh board + two-minute-old acuity cache is NOT current", () => {
    const r = combinedFreshness({ board: ok(NOW - 5_000), acuity: ok(NOW - 120_000), staffing: ok(NOW - 5_000) }, NOW);
    expect(r).toEqual({ freshness: "stale", inputs: { board: "current", acuity: "stale", staffing: "current" } });
  });
  it("all inputs within the window → current", () => {
    expect(combinedFreshness({ board: ok(NOW - 1), acuity: ok(NOW - 1), staffing: ok(NOW - STALE_AFTER_MS) }, NOW).freshness).toBe("current");
  });
  it("invalid and future source times are rejected (bounded skew)", () => {
    expect(inputFreshness({ state: "ok", sourceAt: "not a time" }, NOW)).toBe("invalid_time");
    expect(inputFreshness({ state: "ok", sourceAt: NOW + 10 * 60_000 }, NOW)).toBe("invalid_time");
    expect(inputFreshness({ state: "ok", sourceAt: NOW + 30_000 }, NOW)).toBe("current"); // within skew
  });
  it("distinguishes pending, error, forbidden and stale-after-failed-refresh", () => {
    expect(inputFreshness({ state: "pending", sourceAt: null }, NOW)).toBe("pending");
    expect(inputFreshness({ state: "error", sourceAt: null }, NOW)).toBe("error");
    expect(inputFreshness({ state: "forbidden", sourceAt: null }, NOW)).toBe("forbidden");
    expect(inputFreshness({ state: "ok", sourceAt: NOW, latestFailed: true }, NOW)).toBe("stale");
  });
  it("shift change (new staffing key still loading) or a role change is never current", () => {
    expect(combinedFreshness({ board: ok(NOW), acuity: ok(NOW), staffing: { state: "pending", sourceAt: null } }, NOW).freshness).toBe("none");
    expect(combinedFreshness({ board: { state: "forbidden", sourceAt: null }, acuity: ok(NOW), staffing: ok(NOW) }, NOW).freshness).toBe("none");
  });
});

describe("useUnitCapacity ages every successful read", () => {
  beforeEach(() => {
    __resetSessionScopeForTests();
    board.mockReset();
    acuity.mockReset();
    staffing.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("a hanging acuity refresh makes a fresh board non-reassuring; recovery restores it", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const P = "00000000-0000-4000-8000-000000000001";
    board.mockImplementation(async () =>
      mapPartnerPayload(
        {
          unit_code: "SDH-RADNOR",
          generated_at: new Date().toISOString(),
          bed_board: [
            { bed: "1", is_side_room: false, occupied: true, occupant: { id: P, bed: "1" } },
            { bed: "2", is_side_room: false, occupied: false, occupant: null },
          ],
        },
        new Date().toISOString(),
      ),
    );
    acuity.mockResolvedValue([{ partner_patient_id: P, level: 2, one_to_one: false, updated_at: "x", updated_by: null }]);
    staffing.mockResolvedValue([
      { shift: "day", available_nurses: 4 },
      { shift: "night", available_nurses: 4 },
    ]);
    const { result } = renderHook(() => useUnitCapacity(), { wrapper });
    await waitFor(() => expect(result.current.freshness).toBe("current"));
    expect(result.current.reassuring).toBe(true);

    // Acuity was read 2 minutes ago and its refresh now hangs.
    const st = qc.getQueryCache().find({ queryKey: ACUITY_QK })!;
    act(() => {
      st.setState({ dataUpdatedAt: Date.now() - 120_000 });
    });
    acuity.mockImplementation(() => new Promise(() => undefined));
    await act(async () => {
      result.current.refresh();
      await new Promise((r) => setTimeout(r, 10));
    });
    await waitFor(() => expect(result.current.inputs.acuity).toBe("stale"));
    expect(result.current.freshness).toBe("stale");
    expect(result.current.reassuring).toBe(false);

    // Recovery: a successful acuity read makes it current again.
    act(() => {
      qc.setQueryData(ACUITY_QK, [{ partner_patient_id: P, level: 2, one_to_one: false, updated_at: "y", updated_by: null }]);
    });
    await waitFor(() => expect(result.current.freshness).toBe("current"));
    expect(result.current.reassuring).toBe(true);
  });
});
