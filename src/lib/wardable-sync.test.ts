/**
 * Wardable → Hub transport truthfulness. In-memory local table + fake Hub;
 * no network, no real patients.
 */
import { describe, it, expect } from "vitest";
import { fakeHub } from "@/test-utils/fake-hub";
import { fakeWardableDb } from "@/test-utils/fake-wardable-db";
import {
  retryReviewedWardable,
  reviewWardableRetry,
  runSetWardable,
  syncWardableToHub,
} from "./wardable-status.server";
import { wardableMismatch } from "./wardable-status.functions";
import { mapPartnerPayload, type PartnerBedBoardOk } from "./partner-bed-board-contract";
import { deriveUnitCapacity } from "./unit-capacity";

const PT = "77777777-7777-4777-8777-777777777777";
const actor = { id: "88888888-8888-4888-8888-888888888888", role: "clinician" as const };

const others = (hub: ReturnType<typeof fakeHub>) =>
  hub.calls.filter((c) => c.method === "POST" && !c.url.pathname.endsWith("/patients/wardable"));
const wardablePosts = (hub: ReturnType<typeof fakeHub>) =>
  hub.calls.filter((c) => c.method === "POST" && c.url.pathname.endsWith("/patients/wardable"));

function setup(hubPatient: Record<string, unknown> = {}) {
  const w = fakeWardableDb();
  const hub = fakeHub([{ id: PT, wardable: false, ...hubPatient }]);
  const set = (wardable: boolean, deps: Record<string, unknown> = {}) =>
    runSetWardable(w.db, w.db, { partner_patient_id: PT, wardable }, actor, { ...hub.deps, ...deps });
  const sync = (deps: Record<string, unknown> = {}) => syncWardableToHub(w.db, PT, actor, { ...hub.deps, ...deps });
  return { w, hub, set, sync };
}

/** A fetch whose next GET /patients waits until released. */
function gatedGet(hub: ReturnType<typeof fakeHub>) {
  let release!: () => void;
  let armed = true;
  const gate = new Promise<void>((r) => (release = r));
  let reached!: () => void;
  const atGate = new Promise<void>((r) => (reached = r));
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (armed && (init?.method ?? "GET") === "GET") {
      armed = false;
      const res = await hub.fetchImpl(input, init); // fresh Hub revision read now…
      reached();
      await gate; // …but the caller resumes much later
      return res;
    }
    return hub.fetchImpl(input, init);
  }) as typeof fetch;
  return { fetchImpl, release, atGate };
}

describe("wardable → Hub fenced transport", () => {
  it("sends {id, expected_updated_at, wardable, desired_revision:string} to POST /patients/wardable only", async () => {
    const { w, hub, set } = setup();
    const rev = hub.store.get(PT)!.updated_at;
    const r = await set(true);
    expect(r.ok && r.partner).toMatchObject({ status: "synced", revision: "1", recorded: true });
    expect(wardablePosts(hub).map((c) => c.body)).toEqual([
      { id: PT, expected_updated_at: rev, wardable: true, desired_revision: "1" },
    ]);
    expect(others(hub)).toHaveLength(0); // never the generic patient POST
    expect(w.row(PT)).toMatchObject({ desired_revision: 1, partner_sync_status: "synced", partner_synced_revision: 1 });
    expect(hub.store.get(PT)!.wardable).toBe(true);
  });

  it("counterexample: old true/rev1 waits on its Hub GET, new false/rev2 completes, old resumes → fenced (superseded)", async () => {
    const { w, hub, set } = setup();
    // Allocate rev1 = true locally, but its push stalls inside the Hub GET.
    const g = gatedGet(hub);
    const old = set(true, { fetchImpl: g.fetchImpl });
    await g.atGate;
    // Meanwhile the user flips back: rev2 = false syncs completely.
    const newer = await set(false);
    expect(newer.ok && newer.partner).toMatchObject({ status: "synced", revision: "2" });
    // Old work resumes holding the (now stale) fresh-at-the-time Hub revision.
    g.release();
    const o = await old;
    expect(o.ok && o.partner.status).toBe("pending"); // newer local change wins
    expect(hub.store.get(PT)!.wardable).toBe(false);
    expect(w.row(PT)).toMatchObject({ desired_revision: 2, wardable: false, partner_sync_status: "synced", partner_synced_revision: 2 });
  });

  it("remote fence: an older POST that reaches the Hub after a newer one is rejected as superseded", async () => {
    const { w, hub, sync, set } = setup();
    await set(true); // rev1 synced
    // rev2 = false allocated; its push is the "old" in-flight work below.
    await w.db.rpc("set_wardable_desired_state", { _partner_patient_id: PT, _wardable: false });
    // Just as rev2's POST arrives, a newer toggle (rev3 = true) is saved and fully synced.
    hub.control.beforeWardable = async () => {
      const r3 = await set(true);
      expect(r3.ok && r3.partner).toMatchObject({ status: "synced", revision: "3" });
    };
    const o2 = await sync();
    expect(o2).toMatchObject({ status: "pending", reason: "newer_local_change", revision: "2", recorded: false });
    expect(hub.audit.filter((a) => a.revision === "2").map((a) => a.result)).toEqual(["superseded"]);
    expect(hub.store.get(PT)!.wardable).toBe(true);
    expect(w.row(PT)).toMatchObject({ desired_revision: 3, partner_sync_status: "synced", partner_synced_revision: 3 });
  });

  it("out-of-order responses: a late success for rev1 never marks rev2 synced", async () => {
    const { w, hub, set, sync } = setup();
    await w.db.rpc("set_wardable_desired_state", { _partner_patient_id: PT, _wardable: true }); // rev1
    let release!: () => void;
    hub.control.holdWardableResponse = new Promise<void>((r) => (release = r));
    const late = sync(); // rev1 applied at the Hub, response held
    await new Promise((r) => setTimeout(r, 5));
    hub.control.holdWardableResponse = null;
    const r2 = await set(false); // rev2 applied + recorded
    expect(r2.ok && r2.partner).toMatchObject({ status: "synced", revision: "2" });
    release();
    expect(await late).toMatchObject({ status: "pending", reason: "newer_local_change", recorded: false });
    expect(w.row(PT)).toMatchObject({ desired_revision: 2, partner_synced_revision: 2, partner_sync_status: "synced" });
    expect(hub.store.get(PT)!.wardable).toBe(false);
  });

  it("equal boolean still calls the endpoint to reserve the new revision (fences older in-flight work)", async () => {
    const { w, hub, set, sync } = setup({ wardable: true }); // Hub already shows true
    await w.db.rpc("set_wardable_desired_state", { _partner_patient_id: PT, _wardable: false }); // rev1 (old, in flight)
    const r2 = await set(true); // rev2 = true, equal to Hub's current value
    expect(r2.ok && r2.partner).toMatchObject({ status: "synced", revision: "2" });
    expect(wardablePosts(hub).map((c) => c.body?.desired_revision)).toEqual(["2"]);
    expect(hub.fence.get(PT)).toMatchObject({ reserved: 2n, wardable: true });
    // The stale rev1 can no longer win, even sent directly to the Hub.
    const { postHubWardable } = await import("./hub-client.server");
    const stale = await postHubWardable(
      { id: PT, expected_updated_at: hub.store.get(PT)!.updated_at, wardable: false, desired_revision: "1" },
      actor,
      hub.deps,
    );
    expect(stale).toEqual({ kind: "conflict", code: "superseded", desired_revision: "1" });
    expect(hub.store.get(PT)!.wardable).toBe(true);
    expect(await sync()).toMatchObject({ status: "synced", revision: "2" }); // replay is idempotent
  });

  it("simultaneous toggles get distinct increasing revisions and the Hub ends on the latest", async () => {
    const { w, hub, set } = setup();
    const results = await Promise.all([set(true), set(false), set(true)]);
    const revs = results.map((r) => (r.ok ? Number(r.local.desired_revision) : -1)).sort();
    expect(revs).toEqual([1, 2, 3]);
    expect(w.row(PT)).toMatchObject({ desired_revision: 3, wardable: true });
    expect(hub.store.get(PT)!.wardable).toBe(true);
    expect(hub.fence.get(PT)!.reserved).toBe(3n);
  });

  it("replay of an applied revision is already_applied and never rewrites the Hub", async () => {
    const { hub, set, sync } = setup();
    await set(true);
    const before = hub.store.get(PT)!.updated_at;
    expect(await sync()).toMatchObject({ status: "synced", revision: "1" });
    expect(hub.audit.map((a) => a.result)).toEqual(["applied", "already_applied"]);
    expect(hub.store.get(PT)!.updated_at).toBe(before);
  });

  it("overlay deletion/recreation never resets or reuses a revision", async () => {
    const { w, hub, set } = setup();
    await set(true);
    await set(false);
    w.deleteRow(PT); // outbox cleanup / overlay deleted
    const r = await set(true);
    expect(r.ok && r.local.desired_revision).toBe(3);
    expect(r.ok && r.partner).toMatchObject({ status: "synced", revision: "3" });
    expect(hub.store.get(PT)!.wardable).toBe(true);
  });

  it("crash after local save: outbox stays pending; review + retry sends the latest revision", async () => {
    const { w, hub } = setup();
    await w.db.rpc("set_wardable_desired_state", { _partner_patient_id: PT, _wardable: true }); // crash before push
    expect(w.row(PT)!.partner_sync_status).toBe("pending");
    const review = await reviewWardableRetry(w.db, PT, actor, hub.deps);
    expect(review).toEqual({
      local: { wardable: true, desired_revision: "1", partner_sync_status: "pending" },
      hub: { state: "ok", wardable: false },
    });
    expect(await retryReviewedWardable(w.db, PT, "1", actor, hub.deps)).toMatchObject({ status: "synced", revision: "1" });
  });

  it("crash after the Hub applied but before the outcome was saved: retry reports already_applied → synced", async () => {
    const { w, hub } = setup();
    await w.db.rpc("set_wardable_desired_state", { _partner_patient_id: PT, _wardable: true });
    const { postHubWardable } = await import("./hub-client.server");
    await postHubWardable({ id: PT, expected_updated_at: hub.store.get(PT)!.updated_at, wardable: true, desired_revision: "1" }, actor, hub.deps);
    expect(w.row(PT)!.partner_sync_status).toBe("pending");
    expect(await retryReviewedWardable(w.db, PT, "1", actor, hub.deps)).toMatchObject({ status: "synced" });
    expect(hub.audit.map((a) => a.result)).toEqual(["applied", "already_applied"]);
  });

  it("revision_conflict is NOT auto-rebased; retry requires review of the current revision", async () => {
    const { w, hub, set } = setup();
    hub.control.beforeWardable = () => hub.externalEdit(PT, { outstanding_tasks: "someone else" });
    const r = await set(true);
    expect(r.ok && r.partner).toMatchObject({ status: "conflict", reason: "revision_conflict", recorded: true });
    expect(wardablePosts(hub)).toHaveLength(1); // no automatic second attempt
    expect(w.row(PT)!.partner_sync_status).toBe("conflict");
    // A retry for a revision the user did not review is refused.
    expect(await retryReviewedWardable(w.db, PT, "7", actor, hub.deps)).toMatchObject({ status: "pending", reason: "changed_since_review" });
    expect(wardablePosts(hub)).toHaveLength(1);
    // After review, the same revision applies with a fresh Hub revision.
    expect(await retryReviewedWardable(w.db, PT, "1", actor, hub.deps)).toMatchObject({ status: "synced", revision: "1" });
    expect(hub.store.get(PT)!.wardable).toBe(true);
  });

  it("intent conflict (same revision, different boolean) is reported, not applied", async () => {
    const { w, hub, sync } = setup();
    hub.fence.set(PT, { reserved: 1n, wardable: false, applied: false });
    await w.db.rpc("set_wardable_desired_state", { _partner_patient_id: PT, _wardable: true }); // rev1 = true
    expect(await sync()).toMatchObject({ status: "conflict", reason: "intent_conflict" });
    expect(hub.store.get(PT)!.wardable).toBe(false);
  });

  it("revoked sharing → not_shared; target changed mid-flight → not_shared/target_changed", async () => {
    const a = setup();
    a.hub.unshare(PT);
    const ra = await a.set(true);
    expect(ra.ok && ra.partner).toMatchObject({ status: "not_shared", reason: "not_shared" });
    expect(wardablePosts(a.hub)).toHaveLength(0);
    const b = setup();
    b.hub.control.beforeWardable = () => void b.hub.unshare(PT);
    const rb = await b.set(true);
    expect(rb.ok && rb.partner).toMatchObject({ status: "not_shared", reason: "target_changed" });
  });

  it("missing Hub endpoint fails closed with no generic patient POST fallback", async () => {
    const { w, hub, set } = setup();
    hub.control.noWardableEndpoint = true;
    const r = await set(true);
    expect(r.ok && r.partner).toMatchObject({ status: "failed", reason: "endpoint_unavailable" });
    expect(others(hub)).toHaveLength(0);
    expect(w.row(PT)).toMatchObject({ wardable: true, partner_sync_status: "failed" }); // local save kept, reported separately
  });

  it("outage and timeout → failed; recovery after review", async () => {
    const { w, hub, set } = setup();
    hub.control.down = true;
    const r = await set(true);
    expect(r.ok && r.partner).toMatchObject({ status: "failed", reason: "unavailable" });
    hub.control.down = false;
    hub.control.hang = true;
    expect(await retryReviewedWardable(w.db, PT, "1", actor, hub.deps)).toMatchObject({ status: "failed", reason: "unavailable" });
    hub.control.hang = false;
    expect(await retryReviewedWardable(w.db, PT, "1", actor, hub.deps)).toMatchObject({ status: "synced" });
  });

  it("a Hub success that echoes a different revision, patient or boolean is not accepted", async () => {
    for (const bad of [
      { desired_revision: "9" },
      { patient: { id: "11111111-1111-4111-8111-111111111111", wardable: true, wardable_at: null, updated_at: "2026-11-16T10:00:00Z" } },
      { patient: { id: PT, wardable: false, wardable_at: null, updated_at: "2026-11-16T10:00:00Z" } },
    ]) {
      const { hub, set } = setup();
      const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await hub.fetchImpl(input, init);
        if (!String(input).endsWith("/patients/wardable")) return res;
        const body = { ...(await res.json()), ...bad };
        return new Response(JSON.stringify(body), { status: 200 });
      }) as typeof fetch;
      const r = await set(true, { fetchImpl });
      expect(r.ok && r.partner).toMatchObject({ status: "failed", reason: "invalid" });
    }
  });

  it("database without the revision procedure (migration not yet applied) fails closed before any Hub call", async () => {
    const w = fakeWardableDb({ rpcMissing: true });
    const hub = fakeHub([{ id: PT, wardable: false }]);
    const r = await runSetWardable(w.db, w.db, { partner_patient_id: PT, wardable: true }, actor, hub.deps);
    expect(r).toMatchObject({ ok: false, code: "unavailable" });
    expect(hub.calls).toHaveLength(0);
    const f = fakeWardableDb({ clinical: false });
    expect(await runSetWardable(f.db, f.db, { partner_patient_id: PT, wardable: true }, actor, hub.deps)).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("outcome messages never contain patient ids or secrets", async () => {
    const { hub, set } = setup();
    hub.control.down = true;
    const r = await set(true);
    const text = JSON.stringify(r.ok && r.partner.message);
    expect(text).not.toContain(PT);
    expect(text).not.toContain("synthetic-secret");
  });

  it("mismatch is reconstructed after reload from the saved outcome or the Hub's actual flag", () => {
    const synced = { wardable: true, desired_revision: 3, partner_sync_status: "synced" as const, partner_synced_revision: 3 };
    expect(wardableMismatch(synced, undefined).mismatch).toBe(false);
    expect(wardableMismatch(synced, false)).toEqual({ mismatch: true, reason: "hub_differs" });
    expect(wardableMismatch({ ...synced, partner_sync_status: "failed" }, undefined)).toEqual({ mismatch: true, reason: "failed" });
    expect(wardableMismatch({ ...synced, partner_synced_revision: 2 }, undefined).mismatch).toBe(true);
    expect(wardableMismatch({ ...synced, partner_sync_status: "failed" }, true).mismatch).toBe(false);
  });
});

describe("local discharge timing is not a Hub discharge", () => {
  it("a recorded discharge time keeps the bed occupied and in nursing demand until the Hub roster frees it", () => {
    const board = mapPartnerPayload(
      {
        unit_code: "SDH-RADNOR",
        bed_board: [{ bed: "1", is_side_room: false, occupied: true, occupant: { id: PT, bed: "1" } }],
      },
      new Date().toISOString(),
    ) as PartnerBedBoardOk;
    // The local stamp (discharged_at) is not an input to the capacity model at all.
    const d = deriveUnitCapacity({
      board: { status: "ok", value: board },
      acuity: { status: "ok", value: [{ partner_patient_id: PT, level: 2, one_to_one: false }] },
      staffing: { status: "ok", value: 1 },
    });
    expect(d.physical).toMatchObject({ occupied: 1, vacant: 0 });
    expect(d.nursing.state === "ok" && d.nursing.dependency).toBe(0.5);
    // Only when the Hub roster shows the bed free does it become vacant.
    const freed = mapPartnerPayload(
      { unit_code: "SDH-RADNOR", bed_board: [{ bed: "1", is_side_room: false, occupied: false, occupant: null }] },
      new Date().toISOString(),
    ) as PartnerBedBoardOk;
    const d2 = deriveUnitCapacity({
      board: { status: "ok", value: freed },
      acuity: { status: "ok", value: [] },
      staffing: { status: "ok", value: 1 },
    });
    expect(d2.physical).toMatchObject({ occupied: 0, vacant: 1 });
  });
});
