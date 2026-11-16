import { describe, it, expect, vi } from "vitest";

// Never load the real web-push sender in tests.
vi.mock("./push.server", () => ({
  sendPushToMany: vi.fn(async () => ({ results: [], goneEndpoints: [] })),
}));

import { checkAndAlertNurseCapacity } from "./nurse-capacity-alerts.server";
import type { PartnerBedBoardResult } from "./partner-bed-board-contract";
import { mapPartnerPayload } from "./partner-bed-board-contract";

/**
 * Synthetic in-memory admin client. Reads come from `tables`; the claim RPC
 * emulates drizzle/staged/0005_capacity_alert_claim.sql in one "transaction"
 * (state CAS + notifications with unique (user_id, event_key) + event row),
 * rolling back everything when a step fails. Sends nothing.
 */
type Res = { data: unknown; error: unknown };
function fakeAdmin(tables: Record<string, Res>, opts: { claimMissing?: boolean; notifInsertFails?: boolean; recordFails?: boolean } = {}) {
  const writes: Array<{ table: string; op: string }> = [];
  const db = {
    state: (tables.nurse_capacity_alert_state?.data as Record<string, unknown> | null) ?? null,
    notifications: [] as Array<{ user_id: string; message: string; event_key: string }>,
    events: new Map<string, Record<string, unknown>>(),
    opts,
  };
  const from = (table: string) => {
    const res = (): Res =>
      table === "nurse_capacity_alert_state" && !tables[table]?.error ? { data: db.state, error: null } : tables[table] ?? { data: null, error: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {};
    for (const m of ["select", "eq", "in", "is", "not", "order", "limit"]) b[m] = () => b;
    b.maybeSingle = async () => res();
    b.single = async () => res();
    for (const op of ["upsert", "insert", "update"]) {
      b[op] = () => {
        writes.push({ table, op });
        return Promise.resolve({ data: null, error: null });
      };
    }
    b.delete = () => {
      writes.push({ table, op: "delete" });
      return b;
    };
    b.then = (ok: (v: Res) => unknown, err: (e: unknown) => unknown) => Promise.resolve(res()).then(ok, err);
    return b;
  };
  const rpc = async (fn: string, args: Record<string, any>) => {
    if (opts.claimMissing) return { data: null, error: { code: "PGRST202" } };
    if (fn === "claim_nurse_capacity_transition") {
      const cur = Number(db.state?.state_revision ?? 0);
      if (cur !== args._expected_revision) return { data: { claimed: false, reason: "state_changed" }, error: null };
      // --- transaction ---
      if (args._event_key && opts.notifInsertFails) return { data: null, error: { code: "23502" } }; // rollback
      if (args._event_key && db.events.has(args._event_key)) return { data: null, error: { code: "23505" } };
      let inserted = 0;
      for (const n of args._notifications as Array<{ user_id: string; message: string }>) {
        if (!args._event_key) break;
        if (db.notifications.some((x) => x.user_id === n.user_id && x.event_key === args._event_key)) continue;
        db.notifications.push({ ...n, event_key: args._event_key });
        inserted++;
      }
      db.state = { ...args._state, state_revision: cur + 1 };
      if (args._event_key) db.events.set(args._event_key, { levels: args._levels, inserted });
      writes.push({ table: "rpc", op: fn });
      return { data: { claimed: true, revision: cur + 1, notifications_inserted: inserted }, error: null };
    }
    if (fn === "record_capacity_alert_delivery") {
      if (opts.recordFails) return { data: null, error: { code: "XX000" } };
      const e = db.events.get(args._event_key);
      if (e) Object.assign(e, { push: { a: args._attempted, d: args._delivered, f: args._failed } });
      return { data: !!e, error: null };
    }
    return { data: null, error: { code: "PGRST202" } };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { admin: { from, rpc } as any, writes, db };
}

const NOW = new Date("2026-07-10T09:00:00Z"); // 10:00 BST → day shift 2026-07-10
const clock = () => NOW.getTime();
const boardOf = (payload: unknown, generatedAt?: string) => async (): Promise<PartnerBedBoardResult> =>
  mapPartnerPayload(
    { unit_code: "SDH-RADNOR", ...(generatedAt ? { generated_at: generatedAt } : {}), ...(payload as object) },
    NOW.toISOString(),
  );

const ONE_PATIENT = {
  bed_board: [
    { bed: "1", is_side_room: false, occupied: true, occupant: { id: "syn-1", bed: "1" } },
    { bed: "2", is_side_room: false, occupied: false, occupant: null },
  ],
};

const USER = "00000000-0000-4000-8000-0000000000aa";
const baseTables = (over: Record<string, Res> = {}): Record<string, Res> => ({
  patient_acuity_overrides: { data: [{ partner_patient_id: "syn-1", level: 3, one_to_one: false }], error: null },
  nurse_staffing: { data: [{ shift: "day", available_nurses: 3 }], error: null },
  nurse_capacity_alert_state: { data: null, error: null },
  profiles: { data: [{ id: USER }], error: null },
  push_subscriptions: { data: [{ user_id: USER, endpoint: "https://push.invalid/x", p256dh: "k", auth: "a" }], error: null },
  ...over,
});
const okPush = () => vi.fn(async (subs: Array<{ endpoint: string; user_id?: string }>) => ({
  results: subs.map((s) => ({ endpoint: s.endpoint, user_id: s.user_id ?? "", ok: true })),
  goneEndpoints: [] as string[],
}));

describe("capacity alerts fail closed when inputs are not trustworthy", () => {
  const old = new Date(NOW.getTime() - 5 * 60_000).toISOString();
  const future = new Date(NOW.getTime() + 10 * 60_000).toISOString();
  const cases: Array<[string, () => Promise<PartnerBedBoardResult>, Record<string, Res>, string]> = [
    ["partner failure", async () => ({ ok: false, error: "down", fetched_at: NOW.toISOString(), partner_outage: true }), {}, "board_unavailable"],
    ["partner throws", async () => { throw new Error("network"); }, {}, "board_unavailable"],
    ["malformed partner payload", boardOf({ bed_board: [{ bed: "1" }] }), {}, "board_indeterminate"],
    ["stale Hub snapshot (5 min old)", boardOf(ONE_PATIENT, old), {}, "board_stale"],
    ["Hub snapshot in the future", boardOf(ONE_PATIENT, future), {}, "board_indeterminate"],
    ["occupied bed with withheld occupant", boardOf({ bed_board: [{ bed: "1", is_side_room: false, occupied: true, occupant: null }] }), {}, "withheld"],
    ["acuity query error", boardOf(ONE_PATIENT), { patient_acuity_overrides: { data: null, error: { message: "x" } } }, "acuity_unavailable"],
    ["staffing query error", boardOf(ONE_PATIENT), { nurse_staffing: { data: null, error: { message: "x" } } }, "staffing_unavailable"],
    ["no nurse count recorded", boardOf(ONE_PATIENT), { nurse_staffing: { data: [], error: null } }, "no_staffing"],
    ["previous-state read fails", boardOf(ONE_PATIENT), { nurse_capacity_alert_state: { data: null, error: { message: "x" } } }, "state_unavailable"],
    ["recipient read fails", boardOf(ONE_PATIENT), { profiles: { data: null, error: { message: "x" } } }, "recipients_unavailable"],
  ];
  for (const [name, fetchBoard, over, reason] of cases) {
    it(`${name}: no state change, no notification, no push`, async () => {
      const sendPush = okPush();
      const { admin, writes, db } = fakeAdmin(baseTables(over));
      const out = await checkAndAlertNurseCapacity(admin, NOW, { fetchBoard, sendPush, clock });
      expect(out).toEqual({ kind: "suppressed", reason });
      expect(writes).toEqual([]);
      expect(db.notifications).toEqual([]);
      expect(sendPush).not.toHaveBeenCalled();
    });
  }

  it("inputs that went stale while reading are re-checked before the claim", async () => {
    let t = NOW.getTime();
    const sendPush = okPush();
    const { admin, writes } = fakeAdmin(baseTables());
    const fetchBoard = async () => {
      const b = await boardOf(ONE_PATIENT)();
      t += 2 * 60_000; // a hanging read: two minutes pass before we can claim
      return b;
    };
    const out = await checkAndAlertNurseCapacity(admin, NOW, { fetchBoard, sendPush, clock: () => t });
    expect(out.kind).toBe("suppressed");
    expect(writes).toEqual([]);
    expect(sendPush).not.toHaveBeenCalled();
  });

  it("claim procedure not yet applied → suppressed, nothing sent", async () => {
    const sendPush = okPush();
    const { admin, db } = fakeAdmin(baseTables(), { claimMissing: true });
    expect(await checkAndAlertNurseCapacity(admin, NOW, { fetchBoard: boardOf(ONE_PATIENT), sendPush, clock })).toEqual({
      kind: "suppressed",
      reason: "claim_unavailable",
    });
    expect(db.notifications).toEqual([]);
    expect(sendPush).not.toHaveBeenCalled();
  });
});

describe("capacity alerts with determinate inputs", () => {
  it("alerts on a flip using the shared calculation (3 nurses, 1 L3 patient → 2 L3 slots)", async () => {
    const sendPush = okPush();
    const { admin, db } = fakeAdmin(baseTables());
    const out = await checkAndAlertNurseCapacity(admin, NOW, { fetchBoard: boardOf(ONE_PATIENT), sendPush, clock });
    expect(out).toMatchObject({ kind: "alerted", recipients: 1, notifications_inserted: 1, push: { attempted: 1, delivered: 1, failed: 0, recorded: true } });
    expect(db.state).toMatchObject({ state_revision: 1, level3_available: true });
    expect(db.notifications).toHaveLength(1);
    const payload = (sendPush.mock.calls[0] as unknown as [unknown, { body: string; url: string }])[1];
    expect(payload.url).toBe("/bed-board?focus_shift=day&focus_level=3");
    expect(payload.body).toMatch(/Level 3: now 2 spare admissions/);
  });

  it("1 nurse + 1 one-to-one patient reports no spare L3", async () => {
    const sendPush = okPush();
    const { admin } = fakeAdmin(
      baseTables({
        patient_acuity_overrides: { data: [{ partner_patient_id: "syn-1", level: 2, one_to_one: true }], error: null },
        nurse_staffing: { data: [{ shift: "day", available_nurses: 1 }], error: null },
        nurse_capacity_alert_state: {
          data: { shift_key: "2026-07-10#day", state_revision: 4, level3_available: true, level2_available: true, level1_available: true, spare: 1 },
          error: null,
        },
      }),
    );
    const out = await checkAndAlertNurseCapacity(admin, NOW, { fetchBoard: boardOf(ONE_PATIENT), sendPush, clock });
    expect(out.kind).toBe("alerted");
    if (out.kind === "alerted") expect(out.levels).toContain("l3");
    const payload = (sendPush.mock.calls[0] as unknown as [unknown, { body: string }])[1];
    expect(payload.body).toMatch(/no spare admissions/);
  });

  it("notification persistence failure rolls back the state; the next run recovers once", async () => {
    const sendPush = okPush();
    const f = fakeAdmin(baseTables(), { notifInsertFails: true });
    expect(await checkAndAlertNurseCapacity(f.admin, NOW, { fetchBoard: boardOf(ONE_PATIENT), sendPush, clock })).toEqual({
      kind: "suppressed",
      reason: "claim_failed",
    });
    expect(f.db.state).toBeNull(); // not advanced
    expect(sendPush).not.toHaveBeenCalled();
    f.db.opts.notifInsertFails = false;
    expect((await checkAndAlertNurseCapacity(f.admin, NOW, { fetchBoard: boardOf(ONE_PATIENT), sendPush, clock })).kind).toBe("alerted");
    expect(f.db.notifications).toHaveLength(1);
    expect((await checkAndAlertNurseCapacity(f.admin, NOW, { fetchBoard: boardOf(ONE_PATIENT), sendPush, clock })).kind).toBe("no_change");
    expect(sendPush).toHaveBeenCalledTimes(1);
  });

  it("concurrent triggers: exactly one claims, no duplicate notifications or pushes", async () => {
    const sendPush = okPush();
    const f = fakeAdmin(baseTables());
    let release!: () => void;
    const barrier = new Promise<void>((r) => (release = r));
    let started = 0;
    const fetchBoard = async () => {
      if (++started === 2) release();
      await barrier; // both runs read the same previous state
      return boardOf(ONE_PATIENT)();
    };
    const [a, b] = await Promise.all([
      checkAndAlertNurseCapacity(f.admin, NOW, { fetchBoard, sendPush, clock }),
      checkAndAlertNurseCapacity(f.admin, NOW, { fetchBoard, sendPush, clock }),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(["alerted", "lost_race"]);
    expect(f.db.notifications).toHaveLength(1);
    expect(sendPush).toHaveBeenCalledTimes(1);
  });

  it("push failure is reported as partial delivery, never re-sent as a duplicate; delivery-record failure is reported", async () => {
    const sendPush = vi.fn(async () => {
      throw new Error("push service down");
    });
    const f = fakeAdmin(baseTables(), { recordFails: true });
    const out = await checkAndAlertNurseCapacity(f.admin, NOW, { fetchBoard: boardOf(ONE_PATIENT), sendPush, clock });
    expect(out).toMatchObject({ kind: "alerted", notifications_inserted: 1, push: { attempted: 1, delivered: 0, failed: 1, recorded: false } });
    // Same situation again: state already claimed → no second alert.
    expect((await checkAndAlertNurseCapacity(f.admin, NOW, { fetchBoard: boardOf(ONE_PATIENT), sendPush, clock })).kind).toBe("no_change");
    expect(f.db.notifications).toHaveLength(1);
  });

  it("a newer stored state is never replayed by a run that read an older one", async () => {
    const sendPush = okPush();
    const f = fakeAdmin(baseTables({
      nurse_capacity_alert_state: { data: { shift_key: "2026-07-10#day", state_revision: 9, level3_available: false, level2_available: false, level1_available: false }, error: null },
    }));
    const newer = { shift_key: "2026-07-10#day", state_revision: 10, level3_available: true, level2_available: true, level1_available: true };
    const racing = {
      ...f.admin,
      rpc: (fn: string, args: Record<string, unknown>) => {
        if (fn === "claim_nurse_capacity_transition") f.db.state = { ...newer }; // concurrent writer lands first
        return f.admin.rpc(fn, args);
      },
    };
    const out = await checkAndAlertNurseCapacity(racing, NOW, { fetchBoard: boardOf(ONE_PATIENT), sendPush, clock });
    expect(out.kind).toBe("lost_race");
    expect(f.db.state).toEqual(newer);
    expect(f.db.notifications).toEqual([]);
    expect(sendPush).not.toHaveBeenCalled();
  });
});
