/**
 * Wardable → Hub transport truthfulness. In-memory local table + fake Hub;
 * no network, no real patients.
 */
import { describe, it, expect } from "vitest";
import { fakeHub } from "@/test-utils/fake-hub";
import { fakeTable } from "@/test-utils/fake-table";
import { syncWardableToHub, type WardableDb } from "./wardable-status.server";
import { wardableMismatch } from "./wardable-status.functions";
import { mapPartnerPayload, type PartnerBedBoardOk } from "./partner-bed-board-contract";
import { deriveUnitCapacity } from "./unit-capacity";

const PT = "77777777-7777-4777-8777-777777777777";
const actor = { id: "88888888-8888-4888-8888-888888888888", role: "clinician" as const };

function setup(local: Record<string, unknown> = {}) {
  const t = fakeTable("partner_patient_id", [
    {
      partner_patient_id: PT,
      wardable: true,
      wardable_at: "2026-11-16T11:00:00.000Z",
      desired_revision: 1,
      partner_sync_status: "pending",
      partner_synced_revision: null,
      ...local,
    },
  ]);
  const hub = fakeHub([{ id: PT, wardable: false }]);
  const db: WardableDb = { from: () => t.table };
  return { t, hub, db };
}

describe("wardable Hub transport", () => {
  it("synced: fresh Hub revision + partial patch, outcome recorded for that revision", async () => {
    const { t, hub, db } = setup();
    const rev = hub.store.get(PT)!.updated_at;
    const out = await syncWardableToHub(db, PT, actor, hub.deps);
    expect(out).toMatchObject({ status: "synced", revision: 1 });
    const post = hub.calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({
      id: PT,
      expected_updated_at: rev,
      wardable: true,
      wardable_at: "2026-11-16T11:00:00.000Z",
      wardable_by: actor.id,
    });
    expect(t.rows[0]).toMatchObject({ partner_sync_status: "synced", partner_synced_revision: 1 });
    expect(hub.store.get(PT)!.wardable).toBe(true);
  });

  it("outage → failed (local save untouched), then a retry sends the latest state", async () => {
    const { t, hub, db } = setup();
    hub.control.down = true;
    expect(await syncWardableToHub(db, PT, actor, hub.deps)).toMatchObject({ status: "failed" });
    expect(t.rows[0]).toMatchObject({ wardable: true, partner_sync_status: "failed" });
    hub.control.down = false;
    expect(await syncWardableToHub(db, PT, actor, hub.deps)).toMatchObject({ status: "synced" });
  });

  it("conflict is retried once with a fresh revision; persistent conflict is reported", async () => {
    const { hub, db } = setup();
    hub.control.beforePost = () => hub.externalEdit(PT, { outstanding_tasks: "other" });
    expect(await syncWardableToHub(db, PT, actor, hub.deps)).toMatchObject({ status: "synced" });

    const s2 = setup();
    let n = 0;
    const always = () => {
      s2.hub.externalEdit(PT, { n: ++n });
      s2.hub.control.beforePost = always;
    };
    s2.hub.control.beforePost = always;
    expect(await syncWardableToHub(s2.db, PT, actor, s2.hub.deps)).toMatchObject({ status: "conflict" });
    expect(s2.t.rows[0].partner_sync_status).toBe("conflict");
  });

  it("revoked sharing → not_shared; not configured → not_configured", async () => {
    const { t, hub, db } = setup();
    hub.unshare(PT);
    expect(await syncWardableToHub(db, PT, actor, hub.deps)).toMatchObject({ status: "not_shared" });
    expect(t.rows[0].partner_sync_status).toBe("not_shared");
    const nc = setup();
    const prev = process.env.PARTNER_BRIDGE_URL;
    delete process.env.PARTNER_BRIDGE_URL;
    expect(await syncWardableToHub(nc.db, PT, actor, { secret: "x" })).toMatchObject({ status: "not_configured" });
    if (prev) process.env.PARTNER_BRIDGE_URL = prev;
  });

  it("an older sync can never overwrite a newer toggle", async () => {
    const { t, hub, db } = setup();
    // While this sync is in flight, the user toggles wardable OFF (rev 2).
    hub.control.beforePost = () => {
      Object.assign(t.rows[0], { wardable: false, wardable_at: null, desired_revision: 2, partner_sync_status: "pending" });
    };
    await syncWardableToHub(db, PT, actor, hub.deps);
    // The rev-1 outcome must not mark rev 2 as synced.
    expect(t.rows[0]).toMatchObject({ desired_revision: 2, partner_sync_status: "pending" });
    // The retry pushes the LATEST desired state (false), not the old one.
    const out = await syncWardableToHub(db, PT, actor, hub.deps);
    expect(out).toMatchObject({ status: "synced", revision: 2 });
    expect(hub.store.get(PT)!.wardable).toBe(false);
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
