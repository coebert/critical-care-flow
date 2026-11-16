/**
 * Confirmed Hub bed contract additions: unit scope, generated_at source
 * staleness, hidden unassigned, missing level ≠ L1, Hub indeterminate HTTP
 * errors, and bounded request timeouts. Synthetic data only.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("./push.server", () => ({ sendPushToMany: vi.fn(async () => ({ results: [], goneEndpoints: [] })) }));

import { mapPartnerPayload, type PartnerBedBoardOk } from "./partner-bed-board-contract";
import { boardSourceTime, deriveUnitCapacity, freshnessOf, isReassuring } from "./unit-capacity";
import { fetchPartnerBedBoardSigned } from "./partner-bed-board.server";
import { checkAndAlertNurseCapacity } from "./nurse-capacity-alerts.server";

const AT = "2026-11-16T12:00:00.000Z";
const slot = (bed: string, occ: unknown, occupied = occ != null) => ({ bed, is_side_room: false, occupied, occupant: occ });
const ok = <T,>(value: T) => ({ status: "ok" as const, value });

describe("unit scope", () => {
  it("accepts the configured unit_code and rejects any other", () => {
    expect(mapPartnerPayload({ unit_code: "SDH-RADNOR", bed_board: [] }, AT).ok).toBe(true);
    const other = mapPartnerPayload({ unit_code: "RUH-ICU", unit: "Radnor Critical Care Unit", bed_board: [] }, AT);
    expect(other).toMatchObject({ ok: false, indeterminate: true });
  });
  it("older payloads without unit_code need the expected unit label", () => {
    expect(mapPartnerPayload({ unit: "Radnor Critical Care Unit", bed_board: [] }, AT).ok).toBe(true);
    expect(mapPartnerPayload({ unit: "Some Other ICU", bed_board: [] }, AT).ok).toBe(false);
  });
});

describe("generated_at", () => {
  it("is validated and drives staleness even when the fetch itself is fresh", () => {
    expect(mapPartnerPayload({ unit_code: "SDH-RADNOR", generated_at: "noon", bed_board: [] }, AT).ok).toBe(false);
    expect(mapPartnerPayload({ unit_code: "SDH-RADNOR", generated_at: "2026-11-16T12:10:00Z", bed_board: [] }, AT).ok).toBe(false);
    const old = mapPartnerPayload({ unit_code: "SDH-RADNOR", generated_at: "2026-11-16T11:55:00Z", bed_board: [] }, AT) as PartnerBedBoardOk;
    expect(boardSourceTime(old)).toBe("2026-11-16T11:55:00Z");
    const now = Date.parse(AT) + 1000; // fetched one second ago…
    expect(freshnessOf({ lastSuccessAt: boardSourceTime(old), latestFailed: false, now })).toBe("stale");
    expect(freshnessOf({ lastSuccessAt: old.fetched_at, latestFailed: false, now })).toBe("current");
  });
});

describe("stats.unassigned counts ALL active unassigned", () => {
  it("undisclosed unassigned patients make nursing demand unknown", () => {
    const b = mapPartnerPayload(
      {
        unit_code: "SDH-RADNOR",
        bed_board: [slot("1", null, false)],
        unassigned: [{ id: "u1" }],
        stats: { total_beds: 1, occupied: 0, available: 1, unassigned: 3 },
      },
      AT,
    ) as PartnerBedBoardOk;
    expect(b.ok).toBe(true);
    expect(b.stats.unassigned).toBe(3);
    expect(b.hidden_unassigned).toBe(2);
    const d = deriveUnitCapacity({ board: ok(b), acuity: ok([{ partner_patient_id: "u1", level: 1, one_to_one: false }]), staffing: ok(5) });
    expect(d.physical?.unassigned).toBe(3);
    expect(d.nursing).toMatchObject({ state: "unknown", reason: "unassigned_withheld" });
    expect(d.determinate).toBe(false);
  });
  it("a stats count smaller than the disclosed list is rejected", () => {
    const r = mapPartnerPayload(
      { unit_code: "SDH-RADNOR", bed_board: [], unassigned: [{ id: "a" }, { id: "b" }], stats: { total_beds: 0, occupied: 0, available: 0, unassigned: 1 } },
      AT,
    );
    expect(r.ok).toBe(false);
  });
});

describe("missing level is not an observed L1", () => {
  const b = mapPartnerPayload({ unit_code: "SDH-RADNOR", bed_board: [slot("1", { id: "p1", bed: "1" }), slot("2", null)] }, AT) as PartnerBedBoardOk;
  it("no level and no 1:1 → nursing indeterminate, no spare claimed", () => {
    const d = deriveUnitCapacity({ board: ok(b), acuity: ok([]), staffing: ok(4) });
    expect(d.nursing).toMatchObject({ state: "unknown", reason: "acuity_missing" });
    expect(isReassuring(d, "current")).toBe(false);
  });
  it("1:1 with no level is known demand 1.0 — 1 nurse leaves 0 spare and 0 L3", () => {
    const d = deriveUnitCapacity({ board: ok(b), acuity: ok([{ partner_patient_id: "p1", level: null, one_to_one: true }]), staffing: ok(1) });
    expect(d.nursing.state).toBe("ok");
    if (d.nursing.state !== "ok") return;
    expect(d.nursing.dependency).toBe(1);
    expect(d.nursing.spare).toBe(0);
    expect(d.nursing.level3_slots).toBe(0);
  });
  it("capacity alerts are suppressed while a level is missing (no push, no state write)", async () => {
    const writes: string[] = [];
    const sendPush = vi.fn();
    const from = (table: string) => {
      const res =
        table === "patient_acuity_overrides"
          ? { data: [{ partner_patient_id: "p1", level: 0, level_recorded: false, one_to_one: false }], error: null }
          : table === "nurse_staffing"
            ? { data: [{ shift: "day", available_nurses: 4 }], error: null }
            : { data: null, error: null };
      const q: any = {};
      for (const m of ["select", "eq"]) q[m] = () => q;
      q.upsert = () => (writes.push(table), Promise.resolve({ error: null }));
      q.insert = q.upsert;
      q.maybeSingle = async () => res;
      q.then = (a: any, r: any) => Promise.resolve(res).then(a, r);
      return q;
    };
    const out = await checkAndAlertNurseCapacity({ from } as never, new Date(AT), {
      fetchBoard: async () => b,
      sendPush: sendPush as never,
      clock: () => Date.parse(AT),
    });
    expect(out).toEqual({ kind: "suppressed", reason: "acuity_missing" });
    expect(sendPush).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});

describe("Hub transport", () => {
  const deps = { baseUrl: "https://hub.synthetic.test/api/public/bridge", secret: "s", sleep: async () => undefined };
  it("an indeterminate HTTP error is an indeterminate failure, not an outage or counts", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "ambiguous", indeterminate: true }), { status: 503 }));
    const r = await fetchPartnerBedBoardSigned({ ...deps, fetchImpl: fetchImpl as never, maxAttempts: 1 });
    expect(r).toMatchObject({ ok: false, indeterminate: true, partner_outage: false });
  });
  it("a hanging Hub request is bounded by the timeout, then recovers", async () => {
    let hang = true;
    const fetchImpl = vi.fn((_u: unknown, init?: RequestInit) =>
      hang
        ? new Promise<Response>((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("a", "AbortError"))))
        : Promise.resolve(new Response(JSON.stringify({ unit_code: "SDH-RADNOR", bed_board: [] }), { status: 200 })),
    );
    const started = Date.now();
    const r1 = await fetchPartnerBedBoardSigned({ ...deps, fetchImpl: fetchImpl as never, timeoutMs: 30, maxAttempts: 2 });
    expect(r1).toMatchObject({ ok: false, partner_outage: true });
    expect(r1.ok ? "" : r1.error).toMatch(/did not respond/);
    expect(Date.now() - started).toBeLessThan(2000);
    hang = false;
    const r2 = await fetchPartnerBedBoardSigned({ ...deps, fetchImpl: fetchImpl as never, timeoutMs: 30 });
    expect(r2.ok).toBe(true);
  });
});
