// @vitest-environment jsdom
/**
 * Session-scoped cache: sign-out / identity change / role denial clear
 * clinical snapshots synchronously; a late fetch for an old user can never
 * populate the new user's cache; same-user token refresh changes nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";

const board = vi.fn();
vi.mock("@/lib/partner-bed-board.functions", () => ({ getPartnerBedBoard: () => board() }));
vi.mock("@/lib/patient-acuity.functions", () => ({ getPatientAcuity: async () => [] }));
vi.mock("@/lib/nurse-staffing.functions", () => ({ getNurseStaffingForDate: async () => [] }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));

import {
  __resetSessionScopeForTests,
  observeSessionIdentity,
  resetSessionScope,
  sessionScoped,
} from "./session-scope";
import { PARTNER_BOARD_QK, usePartnerBedBoard } from "@/hooks/use-unit-capacity";
import { mapPartnerPayload } from "./partner-bed-board-contract";

const okBoard = (bed: string) =>
  mapPartnerPayload({ unit_code: "SDH-RADNOR", bed_board: [{ bed, is_side_room: false, occupied: false, occupant: null }] }, new Date().toISOString());

beforeEach(() => {
  __resetSessionScopeForTests();
  board.mockReset();
});
afterEach(() => cleanup());

describe("session scope", () => {
  it("A → sign out → B: A's cache is gone synchronously and A's late response never lands in B's cache", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    observeSessionIdentity(qc, "user-a");
    qc.setQueryData(["patient-acuity"], [{ partner_patient_id: "a-patient" }]);

    let resolveA!: (v: unknown) => void;
    const slowA = new Promise((r) => (resolveA = r));
    const fetchA = qc.fetchQuery({ queryKey: ["board", "referrals"], queryFn: sessionScoped(() => slowA) }).catch((e) => e);

    resetSessionScope(qc, null); // sign-out
    expect(qc.getQueryCache().getAll()).toHaveLength(0);

    observeSessionIdentity(qc, "user-b"); // B signs in
    resolveA([{ id: "a-referral" }]);
    const outcome = await fetchA;
    expect(outcome).toBeInstanceOf(Error);
    expect(qc.getQueryData(["board", "referrals"])).toBeUndefined();

    await qc.fetchQuery({ queryKey: ["board", "referrals"], queryFn: sessionScoped(async () => [{ id: "b-referral" }]) });
    expect(qc.getQueryData(["board", "referrals"])).toEqual([{ id: "b-referral" }]);
  });

  it("an identity change without explicit sign-out also clears, and a same-user refresh does not", () => {
    const qc = new QueryClient();
    observeSessionIdentity(qc, "user-a");
    qc.setQueryData(["patient-acuity"], [1]);
    expect(observeSessionIdentity(qc, "user-a")).toBe(false); // token refresh
    expect(qc.getQueryData(["patient-acuity"])).toEqual([1]);
    expect(observeSessionIdentity(qc, "user-b")).toBe(true);
    expect(qc.getQueryData(["patient-acuity"])).toBeUndefined();
  });

  it("same-user clinical-role revocation drops the last-good board and other snapshots, then recovers", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["patient-acuity"], [{ partner_patient_id: "x" }]);
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    let next: unknown = okBoard("1");
    board.mockImplementation(async () => next);
    const { result } = renderHook(() => usePartnerBedBoard(), { wrapper });
    await waitFor(() => expect(result.current.lastOk?.bed_board[0].bed).toBe("1"));

    next = { ok: false, forbidden: true, status: 403, error: "denied", fetched_at: new Date().toISOString() };
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.latestFailure?.forbidden).toBe(true));
    expect(result.current.lastOk).toBeNull();
    expect(qc.getQueryData(["patient-acuity"])).toBeUndefined();

    next = okBoard("2");
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.lastOk?.bed_board[0].bed).toBe("2"));
    expect(result.current.latestFailure).toBeNull();
  });

  it("an ordinary Hub failure keeps the last good board (labelled elsewhere as not current)", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    let next: unknown = okBoard("1");
    board.mockImplementation(async () => next);
    const { result } = renderHook(() => usePartnerBedBoard(), { wrapper });
    await waitFor(() => expect(result.current.lastOk).not.toBeNull());
    next = { ok: false, error: "down", partner_outage: true, fetched_at: new Date().toISOString() };
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.latestFailure?.partner_outage).toBe(true));
    expect(result.current.lastOk?.bed_board[0].bed).toBe("1");
    expect(qc.getQueryData(PARTNER_BOARD_QK)).toBeDefined();
  });

  it("useQuery consumers re-fetch cleanly for the new user after a reset", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    observeSessionIdentity(qc, "a");
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    let who = "a";
    const { result, rerender } = renderHook(
      () => useQuery({ queryKey: ["board", "referrals"], queryFn: sessionScoped(async () => who) }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.data).toBe("a"));
    act(() => {
      resetSessionScope(qc, "b");
    });
    who = "b";
    rerender();
    await waitFor(() => expect(qc.getQueryData(["board", "referrals"])).toBe("b"));
  });
});
