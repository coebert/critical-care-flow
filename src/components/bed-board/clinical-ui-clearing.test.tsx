// @vitest-environment jsdom
/**
 * Mounted UI: patient data and late replies never outlive the selection,
 * the session or an authoritative clinical denial. Synthetic patients,
 * mocked server functions and auth client; no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";

// jsdom lacks these browser APIs used by the dialog's switch/select.
(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
(Element.prototype as any).scrollIntoView ??= () => {};
(Element.prototype as any).hasPointerCapture ??= () => false;

// ---- mocks ---------------------------------------------------------------
const board = vi.fn();
const preview = vi.fn();
const save = vi.fn();
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/partner-bed-board.functions", () => ({
  getPartnerBedBoard: () => board(),
  updatePartnerPatient: (a: unknown) => save(a),
}));
vi.mock("@/lib/patient-acuity.functions", () => ({ getPatientAcuity: async () => [], setPatientAcuity: vi.fn() }));
vi.mock("@/lib/nurse-staffing.functions", () => ({ getNurseStaffingForDate: async () => [] }));
vi.mock("@/lib/partner-handover-prefill.functions", () => ({
  previewPartnerHandoverPrefill: (a: unknown) => preview(a),
  applyPartnerHandoverPrefill: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
// Auth client: signed in as a clinician whose role ROW is still present
// (the realtime revocation has not arrived) — the server is authoritative.
const auth = vi.hoisted(() => ({ roleRows: [{ role: "clinician" }] as unknown[], rpcAccess: true, rpcCalls: 0 }));
vi.mock("@/integrations/supabase/client", () => {
  const user = { id: "11111111-1111-4111-8111-111111111111" };
  const session = { user };
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    in: async () => ({ data: auth.roleRows, error: null }),
  };
  const channel: any = { on: () => channel, subscribe: () => channel };
  return {
    supabase: {
      auth: {
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        getSession: async () => ({ data: { session } }),
      },
      from: () => chain,
      rpc: async () => {
        auth.rpcCalls += 1;
        return { data: auth.rpcAccess, error: null };
      },
      channel: () => channel,
      removeChannel: async () => {},
    },
  };
});

import { EditOccupantDialog } from "./edit-occupant-dialog";
import { ClinicalAccessGate } from "@/components/clinical-access-gate";
import { usePartnerBedBoard, PARTNER_BOARD_QK } from "@/hooks/use-unit-capacity";
import { mapPartnerPayload, type PartnerOccupant } from "@/lib/partner-bed-board-contract";
import {
  __resetSessionScopeForTests,
  clearClinicalDenial,
  currentClinicalEpoch,
  getClinicalScope,
  isClinicalDenial,
  reportClinicalDenial,
  resetSessionScope,
} from "@/lib/session-scope";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const occ = (id: string, marker: string): PartnerOccupant => ({
  id,
  full_name: null,
  hospital_number: null,
  age: 70,
  status: null,
  bed: "1",
  admission_date: null,
  tep_in_place: null,
  dnacpr_decision: null,
  outstanding_tasks: marker,
  updated_at: "2026-11-16T10:00:00.000Z",
});
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
const previewOk = (value: string) => ({
  ok: true as const,
  token: "t",
  fields: [{ field: "outstanding_tasks", label: "Outstanding tasks", value }],
  skipped_fields: [],
  link_basis: "source_referral" as const,
  expires_at: "2026-11-16T12:10:00.000Z",
});
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

let qc: QueryClient;
const wrap = (ui: ReactNode) => render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);

/** Mirrors the bed board: selection in state, dialog keyed by patient + referral. */
function Selection({ onSaved }: { onSaved?: (o: PartnerOccupant) => void }) {
  const [sel, setSel] = useState<PartnerOccupant | null>(null);
  return (
    <div>
      <button onClick={() => setSel(occ(A, "MARKER-A-TASKS"))}>open A</button>
      <button onClick={() => setSel(occ(B, "MARKER-B-TASKS"))}>open B</button>
      <button onClick={() => setSel(null)}>close</button>
      {sel && (
        <EditOccupantDialog
          key={`${sel.id}|REF`}
          occupant={sel}
          currentLevel={null}
          currentOneToOne={false}
          currentAcuityRevision={null}
          sourceReferralId="cccccccc-cccc-4ccc-8ccc-cccccccccccc"
          onClose={() => setSel(null)}
          onSaved={(o) => onSaved?.(o)}
          onAcuityChanged={() => {}}
          onConflictReload={() => {}}
        />
      )}
    </div>
  );
}

beforeEach(() => {
  __resetSessionScopeForTests();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  board.mockReset();
  preview.mockReset();
  save.mockReset();
  Object.values(toast).forEach((f) => f.mockReset());
  auth.roleRows = [{ role: "clinician" }];
  auth.rpcAccess = true;
  auth.rpcCalls = 0;
});
afterEach(() => cleanup());

describe("late replies are bound to the selection", () => {
  it("old patient's prefill preview resolving after switching to another patient is discarded", async () => {
    const a = deferred<unknown>();
    preview.mockImplementationOnce(() => a.promise);
    wrap(<Selection />);
    fireEvent.click(screen.getByText("open A"));
    fireEvent.click(screen.getByRole("button", { name: /preview/i }));
    fireEvent.click(screen.getByText("open B"));
    expect(screen.getByDisplayValue("MARKER-B-TASKS")).toBeTruthy();
    a.resolve(previewOk("MARKER-A-PREVIEW"));
    await flush();
    expect(screen.queryByText("MARKER-A-PREVIEW")).toBeNull();
    expect(screen.queryByDisplayValue("MARKER-A-TASKS")).toBeNull();
    // Recovery: B's own preview still works.
    preview.mockResolvedValueOnce(previewOk("MARKER-B-PREVIEW"));
    fireEvent.click(screen.getByRole("button", { name: /preview/i }));
    await waitFor(() => expect(screen.getByText("MARKER-B-PREVIEW")).toBeTruthy());
    expect(preview.mock.calls.at(-1)![0]).toMatchObject({ data: { partner_patient_id: B } });
  });

  it("closing then reopening the same patient never shows the reply from before the close", async () => {
    const a = deferred<unknown>();
    preview.mockImplementationOnce(() => a.promise);
    wrap(<Selection />);
    fireEvent.click(screen.getByText("open A"));
    fireEvent.click(screen.getByRole("button", { name: /preview/i }));
    fireEvent.click(screen.getByText("close"));
    fireEvent.click(screen.getByText("open A"));
    a.resolve(previewOk("MARKER-A-PREVIEW"));
    await flush();
    expect(screen.queryByText("MARKER-A-PREVIEW")).toBeNull();
    expect(screen.getByRole("button", { name: /preview/i })).toBeTruthy();
  });

  it("a reply that resolves after a clinical denial is discarded even if the dialog is still mounted", async () => {
    const a = deferred<unknown>();
    preview.mockImplementationOnce(() => a.promise);
    wrap(<Selection />);
    fireEvent.click(screen.getByText("open A"));
    fireEvent.click(screen.getByRole("button", { name: /preview/i }));
    act(() => reportClinicalDenial(qc));
    a.resolve(previewOk("MARKER-A-PREVIEW"));
    await flush();
    expect(screen.queryByText("MARKER-A-PREVIEW")).toBeNull();
  });

  it("an old patient's save reply after switching neither toasts nor reports a save", async () => {
    const s = deferred<unknown>();
    save.mockImplementationOnce(() => s.promise);
    const onSaved = vi.fn();
    wrap(<Selection onSaved={onSaved} />);
    fireEvent.click(screen.getByText("open A"));
    fireEvent.change(screen.getByDisplayValue("MARKER-A-TASKS"), { target: { value: "edited" } });
    fireEvent.submit(screen.getByDisplayValue("edited").closest("form")!);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("open B"));
    s.resolve({ ok: true, patient: occ(A, "edited") });
    await flush();
    expect(onSaved).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});

/** Bed board stand-in: the real board hook + an already-open patient editor. */
function BoardWithOpenEditor() {
  const b = usePartnerBedBoard();
  const [sel, setSel] = useState<PartnerOccupant | null>(null);
  const first = b.lastOk?.bed_board[0]?.occupant ?? null;
  return (
    <div>
      {first && <button onClick={() => setSel(first)}>open patient</button>}
      {b.lastOk && sel && (
        <EditOccupantDialog
          key={sel.id}
          occupant={sel}
          currentLevel={null}
          currentOneToOne={false}
          currentAcuityRevision={null}
          sourceReferralId={null}
          onClose={() => setSel(null)}
          onSaved={() => {}}
          onAcuityChanged={() => {}}
          onConflictReload={() => {}}
        />
      )}
    </div>
  );
}

const okBoard = () =>
  mapPartnerPayload(
    {
      unit_code: "SDH-RADNOR",
      bed_board: [{ bed: "1", is_side_room: false, occupied: true, occupant: { ...occ(A, "MARKER-A-TASKS") } }],
    },
    new Date().toISOString(),
  );
const forbidden403 = { ok: false, forbidden: true, status: 403, error: "Your account does not have bed board access (clinical role required)", fetched_at: new Date().toISOString() };

describe("authoritative denial closes the shared clinical gate", () => {
  it("already-open patient data disappears on a board 403 despite the role hook's earlier 'true'", async () => {
    board.mockResolvedValue(okBoard());
    qc.setQueryData(["referrals", "detail", "r1"], { id: "r1", patient_name: "MARKER-REFERRAL" });
    qc.setQueryData(["referrals", "detail", "r1", "notes"], [{ body: "MARKER-NOTE" }]);
    qc.setQueryData(["referrals", "list"], [{ id: "r1" }]);
    wrap(
      <ClinicalAccessGate>
        <BoardWithOpenEditor />
      </ClinicalAccessGate>,
    );
    fireEvent.click(await screen.findByText("open patient"));
    expect(screen.getByDisplayValue("MARKER-A-TASKS")).toBeTruthy();

    // Role revoked server-side; the role row is still visible to the hook.
    auth.rpcAccess = false;
    board.mockResolvedValue(forbidden403);
    await act(async () => {
      await qc.refetchQueries({ queryKey: PARTNER_BOARD_QK });
    });
    await waitFor(() => expect(screen.getByText("Access restricted")).toBeTruthy());
    expect(screen.queryByDisplayValue("MARKER-A-TASKS")).toBeNull();
    expect(getClinicalScope().denied).toBe(true);
    // Referral list, decrypted detail and notes are purged too.
    expect(qc.getQueryData(["referrals", "detail", "r1"])).toBeUndefined();
    expect(qc.getQueryData(["referrals", "detail", "r1", "notes"])).toBeUndefined();
    expect(qc.getQueryData(["referrals", "list"])).toBeUndefined();

    // A failing fresh check keeps it closed.
    fireEvent.click(screen.getByRole("button", { name: /check access again/i }));
    await flush();
    expect(screen.getByText("Access restricted")).toBeTruthy();

    // Only a fresh authorised server check reopens it — with nothing carried over.
    auth.rpcAccess = true;
    board.mockResolvedValue(okBoard());
    fireEvent.click(screen.getByRole("button", { name: /check access again/i }));
    expect(await screen.findByText("open patient")).toBeTruthy();
    expect(screen.queryByDisplayValue("MARKER-A-TASKS")).toBeNull(); // selection was not restored
  });
});

describe("clinical scope rules", () => {
  it("a check that started before the denial cannot clear it", () => {
    const before = currentClinicalEpoch();
    reportClinicalDenial(qc);
    expect(clearClinicalDenial(qc, before)).toBe(false);
    expect(getClinicalScope().denied).toBe(true);
    expect(clearClinicalDenial(qc, currentClinicalEpoch())).toBe(true);
    expect(getClinicalScope().denied).toBe(false);
  });

  it("repeated denials do not churn the epoch; identity change resets the denial", () => {
    reportClinicalDenial(qc);
    const e = currentClinicalEpoch();
    reportClinicalDenial(qc);
    expect(currentClinicalEpoch()).toBe(e);
    resetSessionScope(qc, "someone-else");
    expect(getClinicalScope()).toEqual({ denied: false, epoch: e + 1 });
  });

  it("only this app's clinical refusals count; Hub refusals and permission-check failures do not", () => {
    expect(isClinicalDenial(new Error("Forbidden: clinical access required"))).toBe(true);
    expect(isClinicalDenial(new Error("forbidden: clinical role required"))).toBe(true);
    expect(isClinicalDenial({ ok: false, error: "forbidden: clinical role required" })).toBe(true);
    expect(isClinicalDenial(forbidden403)).toBe(true);
    expect(isClinicalDenial({ ok: false, code: "forbidden", message: "Your account does not have clinical access." })).toBe(true);
    expect(isClinicalDenial({ ok: false, forbidden: true, status: 503, error: "Permission check failed" })).toBe(false);
    expect(isClinicalDenial({ status: "failed", reason: "forbidden", message: "Saved here, but ICU Handover Hub refused the update" })).toBe(false);
    expect(isClinicalDenial(new Error("Could not reach the bed board service"))).toBe(false);
    expect(isClinicalDenial([{ ok: false }])).toBe(false);
  });
});
