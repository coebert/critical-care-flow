// @vitest-environment jsdom
/**
 * The REAL bed board page (src/routes/_authenticated/bed-board.tsx) mounted
 * with synthetic patients and mocked server functions — no network, no live
 * data. Covers late async replies around denial and the wardable review /
 * confirm dialog.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
(Element.prototype as any).scrollIntoView ??= () => {};
(Element.prototype as any).hasPointerCapture ??= () => false;
(Element.prototype as any).releasePointerCapture ??= () => {};
(globalThis as any).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

const fns = vi.hoisted(() => ({
  board: vi.fn(),
  setWardable: vi.fn(),
  review: vi.fn(),
  retry: vi.fn(),
  wardableRows: [] as unknown[],
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), message: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    options: opts,
    useSearch: () => ({}),
    useNavigate: () => () => {},
  }),
}));
vi.mock("@/lib/partner-bed-board.functions", async () => {
  const c = await vi.importActual<typeof import("@/lib/partner-bed-board-contract")>("@/lib/partner-bed-board-contract");
  return { getPartnerBedBoard: () => fns.board(), updatePartnerPatient: vi.fn(), mapPartnerPayload: c.mapPartnerPayload };
});
vi.mock("@/lib/patient-acuity.functions", () => ({ getPatientAcuity: async () => [], setPatientAcuity: vi.fn() }));
vi.mock("@/lib/nurse-staffing.functions", () => ({ getNurseStaffingForDate: async () => [], upsertNurseStaffing: vi.fn() }));
vi.mock("@/lib/patient-airway.functions", () => ({ getPatientAirways: async () => [] }));
vi.mock("@/lib/patient-infection.functions", () => ({ getPatientIsolations: async () => [], setPatientIsolation: vi.fn() }));
vi.mock("@/lib/patient-violence-risk.functions", () => ({ listViolenceRisk: async () => [], setViolenceRisk: vi.fn() }));
vi.mock("@/lib/patient-end-of-life.functions", () => ({ listEndOfLife: async () => [], setEndOfLife: vi.fn() }));
vi.mock("@/lib/patient-scan-transfer.functions", () => ({ listScanTransfer: async () => [], setScanTransfer: vi.fn() }));
vi.mock("@/lib/admission-source.functions", () => ({ getAdmissionSourceContext: vi.fn() }));
vi.mock("@/lib/partner-handover-prefill.functions", () => ({ previewPartnerHandoverPrefill: vi.fn(), applyPartnerHandoverPrefill: vi.fn() }));
vi.mock("@/lib/wardable-status.functions", async () => {
  // Pure helper from the real module's logic (server fns replaced).
  const wardableMismatch = (local: any, hub: boolean | null | undefined) => {
    const lw = local?.wardable === true;
    if (typeof hub === "boolean") return hub === lw ? { mismatch: false, reason: null } : { mismatch: true, reason: local?.partner_sync_status && local.partner_sync_status !== "synced" ? local.partner_sync_status : "hub_differs" };
    return { mismatch: false, reason: null };
  };
  return {
    listWardableStatus: async () => fns.wardableRows,
    setWardableStatus: (a: unknown) => fns.setWardable(a),
    reviewWardableRetry: (a: unknown) => fns.review(a),
    retryWardableSync: (a: unknown) => fns.retry(a),
    getHubAppOrigin: async () => ({ origin: null }),
    dischargePatient: vi.fn(),
    clearDischarge: vi.fn(),
    wardableMismatch,
  };
});
vi.mock("@/integrations/supabase/client", () => {
  const chain: any = { select: () => chain, eq: () => chain, in: async () => ({ data: [], error: null }) };
  const channel: any = { on: () => channel, subscribe: () => channel };
  return {
    supabase: {
      auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), getSession: async () => ({ data: { session: null } }) },
      from: () => chain,
      rpc: async () => ({ data: true, error: null }),
      channel: () => channel,
      removeChannel: async () => {},
    },
  };
});

import { Route } from "@/routes/_authenticated/bed-board";
import { mapPartnerPayload } from "@/lib/partner-bed-board-contract";
import { __resetSessionScopeForTests, reportClinicalDenial, resetSessionScope } from "@/lib/session-scope";

const BedBoardPage = (Route as unknown as { options: { component: () => ReactNode } }).options.component;
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const occupant = (id: string, bed: string) => ({
  id, full_name: null, hospital_number: null, age: 70, status: null, bed, admission_date: null,
  tep_in_place: null, dnacpr_decision: null, outstanding_tasks: null, wardable: false,
  updated_at: "2026-11-16T10:00:00.000Z",
});
const okBoard = () =>
  mapPartnerPayload(
    {
      unit_code: "SDH-RADNOR",
      bed_board: [
        { bed: "1", is_side_room: false, occupied: true, occupant: occupant(A, "1") },
        { bed: "2", is_side_room: false, occupied: true, occupant: occupant(B, "2") },
      ],
    },
    new Date().toISOString(),
  );
const row = (id: string, wardable: boolean) => ({
  partner_patient_id: id, wardable, wardable_at: wardable ? "2026-11-16T09:00:00.000Z" : null, discharged_at: null,
  updated_at: "2026-11-16T09:00:00.000Z", desired_revision: "9007199254740993", partner_sync_status: "failed",
  partner_sync_reason: "unavailable", partner_sync_checked_at: null, partner_synced_revision: null,
});
const review = (id: string, token: string) => ({
  local: { wardable: true, desired_revision: "9007199254740993", updated_at: "2026-11-16T09:00:00.000Z" },
  hub: { state: "ok", wardable: false, updated_at: "2026-11-16T09:30:00.000Z" },
  confirm: { token, mode: "resend", expires_at: "2099-01-01T00:00:00.000Z" },
  id,
});
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => ((resolve = r), (reject = j)));
  return { promise, resolve, reject };
};
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

let qc: QueryClient;
const mount = () => render(<QueryClientProvider client={qc}><BedBoardPage /></QueryClientProvider>);

beforeEach(() => {
  __resetSessionScopeForTests();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fns.board.mockResolvedValue(okBoard());
  fns.wardableRows = [row(A, true), row(B, true)];
  Object.values(toast).forEach((t) => t.mockReset());
  fns.setWardable.mockReset(); fns.review.mockReset(); fns.retry.mockReset();
  window.history.replaceState(null, "", "/bed-board");
});
afterEach(() => { cleanup(); qc.clear(); });

describe("bed board page — late replies", () => {
  it("a wardable change failing after a clinical denial neither restores the old snapshot nor toasts", async () => {
    mount();
    const toggles = await screen.findAllByRole("button", { pressed: true, name: /wardable/i });
    const pending = deferred<never>();
    fns.setWardable.mockReturnValue(pending.promise);
    fireEvent.click(toggles[0]);
    await flush();
    // Denial arrives while the write is in flight: caches are purged.
    // Anything re-read afterwards comes back empty, so old rows can only
    // reappear through the late rollback.
    fns.wardableRows = [];
    act(() => reportClinicalDenial(qc));
    expect(qc.getQueryData(["patient-wardable-status"]) ?? []).toEqual([]);
    await act(async () => { pending.reject(new Error("network")); await pending.promise.catch(() => {}); });
    await flush();
    expect(qc.getQueryData(["patient-wardable-status"]) ?? []).toEqual([]); // previously restored here
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("a wardable change failing after an account change does not restore the previous user's rows", async () => {
    mount();
    const toggles = await screen.findAllByRole("button", { pressed: true, name: /wardable/i });
    const pending = deferred<never>();
    fns.setWardable.mockReturnValue(pending.promise);
    fireEvent.click(toggles[0]);
    await flush();
    fns.wardableRows = []; // the next user has no rows
    act(() => resetSessionScope(qc, "22222222-2222-4222-8222-222222222222"));
    await act(async () => { pending.reject(new Error("late")); await pending.promise.catch(() => {}); });
    await flush();
    expect(qc.getQueryData(["patient-wardable-status"]) ?? []).toEqual([]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("an older confirmation settling does not close a newer review the user opened", async () => {
    mount();
    const retryButtons = await screen.findAllByRole("button", { name: /review and retry/i });
    fns.review.mockResolvedValueOnce(review(A, "token-A"));
    fireEvent.click(retryButtons[0]);
    expect(await screen.findByText("Review the ICU Handover Hub update")).toBeTruthy();

    const confirmA = deferred<unknown>();
    fns.retry.mockReturnValueOnce(confirmA.promise);
    fireEvent.click(screen.getByRole("button", { name: /send “wardable” to hub/i }));
    await waitFor(() => expect(fns.retry).toHaveBeenCalledWith({ data: { review_token: "token-A" } })); // only the token
    await waitFor(() => expect(screen.queryByText("Review the ICU Handover Hub update")).toBeNull());

    // While A is still in flight, open the review for bed 2.
    fns.review.mockResolvedValueOnce(review(B, "token-B"));
    fireEvent.click((await screen.findAllByRole("button", { name: /review and retry/i }))[1]);
    expect(await screen.findByText("Review the ICU Handover Hub update")).toBeTruthy();

    await act(async () => { confirmA.resolve({ status: "synced", reason: null, revision: "9007199254740993", recorded: true, message: "ok" }); });
    await flush();
    // B's review stays open and still offers B's own confirmation.
    expect(screen.getByText("Review the ICU Handover Hub update")).toBeTruthy();
    fns.retry.mockResolvedValueOnce({ status: "synced", reason: null, revision: "9007199254740993", recorded: true, message: "ok" });
    fireEvent.click(screen.getByRole("button", { name: /send “wardable” to hub/i }));
    await waitFor(() => expect(fns.retry).toHaveBeenLastCalledWith({ data: { review_token: "token-B" } }));
  });

  it("a review reply arriving after a denial never opens the dialog", async () => {
    mount();
    const retryButtons = await screen.findAllByRole("button", { name: /review and retry/i });
    const late = deferred<unknown>();
    fns.review.mockReturnValueOnce(late.promise);
    fireEvent.click(retryButtons[0]);
    act(() => reportClinicalDenial(qc));
    await act(async () => { late.resolve(review(A, "token-late")); });
    await flush();
    expect(screen.queryByText("Review the ICU Handover Hub update")).toBeNull();
  });
});
