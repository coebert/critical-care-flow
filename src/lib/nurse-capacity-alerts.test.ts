import { describe, it, expect, vi } from "vitest";

// Never load the real web-push sender in tests.
vi.mock("./push.server", () => ({
  sendPushToMany: vi.fn(async () => ({ results: [], goneEndpoints: [] })),
}));

import { checkAndAlertNurseCapacity } from "./nurse-capacity-alerts.server";
import type { PartnerBedBoardResult } from "./partner-bed-board-contract";
import { mapPartnerPayload } from "./partner-bed-board-contract";

// Synthetic, in-memory fake of the admin client. Records writes; sends nothing.
type Res = { data: unknown; error: unknown };
function fakeAdmin(tables: Record<string, Res>) {
  const writes: Array<{ table: string; op: string }> = [];
  const from = (table: string) => {
    const res: Res = tables[table] ?? { data: null, error: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {};
    for (const m of ["select", "eq", "in", "is", "not", "order", "limit"]) b[m] = () => b;
    b.maybeSingle = async () => res;
    b.single = async () => res;
    b.upsert = () => {
      writes.push({ table, op: "upsert" });
      return Promise.resolve({ data: null, error: null });
    };
    b.insert = () => {
      writes.push({ table, op: "insert" });
      return Promise.resolve({ data: null, error: null });
    };
    b.delete = () => {
      writes.push({ table, op: "delete" });
      return b;
    };
    b.then = (ok: (v: Res) => unknown, err: (e: unknown) => unknown) => Promise.resolve(res).then(ok, err);
    return b;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { admin: { from } as any, writes };
}

const NOW = new Date("2026-07-10T09:00:00Z"); // 10:00 BST → day shift 2026-07-10
const boardOf = (payload: unknown) => async (): Promise<PartnerBedBoardResult> =>
  mapPartnerPayload(payload, NOW.toISOString());

const ONE_PATIENT = {
  bed_board: [
    { bed: "1", is_side_room: false, occupied: true, occupant: { id: "syn-1", bed: "1" } },
    { bed: "2", is_side_room: false, occupied: false, occupant: null },
  ],
};

const baseTables = (over: Record<string, Res> = {}): Record<string, Res> => ({
  patient_acuity_overrides: { data: [{ partner_patient_id: "syn-1", level: 3, one_to_one: false }], error: null },
  nurse_staffing: { data: [{ shift: "day", available_nurses: 3 }], error: null },
  nurse_capacity_alert_state: { data: null, error: null },
  profiles: { data: [{ id: "user-syn" }], error: null },
  push_subscriptions: { data: [{ user_id: "user-syn", endpoint: "https://push.invalid/x", p256dh: "k", auth: "a" }], error: null },
  ...over,
});

describe("capacity alerts are suppressed when inputs are not trustworthy", () => {
  const cases: Array<[string, () => Promise<PartnerBedBoardResult>, Record<string, Res>]> = [
    ["partner failure", async () => ({ ok: false, error: "down", fetched_at: NOW.toISOString(), partner_outage: true }), {}],
    ["partner throws", async () => { throw new Error("network"); }, {}],
    ["malformed partner payload", boardOf({ bed_board: [{ bed: "1" }] }), {}],
    [
      "occupied bed with withheld occupant",
      boardOf({ bed_board: [{ bed: "1", is_side_room: false, occupied: true, occupant: null }] }),
      {},
    ],
    ["acuity query error", boardOf(ONE_PATIENT), { patient_acuity_overrides: { data: null, error: { message: "x" } } }],
    ["staffing query error", boardOf(ONE_PATIENT), { nurse_staffing: { data: null, error: { message: "x" } } }],
    ["no nurse count recorded", boardOf(ONE_PATIENT), { nurse_staffing: { data: [], error: null } }],
  ];

  for (const [name, fetchBoard, over] of cases) {
    it(`${name}: no state write, no notification, no push`, async () => {
      const sendPush = vi.fn(async () => ({ results: [], goneEndpoints: [] as string[] }));
      const { admin, writes } = fakeAdmin(baseTables(over));
      const out = await checkAndAlertNurseCapacity(admin, NOW, { fetchBoard, sendPush });
      expect(out.kind).toBe("suppressed");
      expect(writes).toEqual([]);
      expect(sendPush).not.toHaveBeenCalled();
    });
  }
});

describe("capacity alerts with determinate inputs", () => {
  it("alerts on a flip using the shared calculation (3 nurses, 1 L3 patient → 2 L3 slots)", async () => {
    const sendPush = vi.fn(async () => ({ results: [], goneEndpoints: [] as string[] }));
    const { admin, writes } = fakeAdmin(baseTables());
    const out = await checkAndAlertNurseCapacity(admin, NOW, { fetchBoard: boardOf(ONE_PATIENT), sendPush });
    expect(out.kind).toBe("alerted");
    expect(writes).toContainEqual({ table: "nurse_capacity_alert_state", op: "upsert" });
    expect(sendPush).toHaveBeenCalledTimes(1);
    const payload = (sendPush.mock.calls[0] as unknown as [unknown, { body: string; url: string }])[1];
    expect(payload.url).toBe("/bed-board?focus_shift=day&focus_level=3");
    expect(payload.body).toMatch(/Level 3: now 2 spare admissions/);
  });

  it("1 nurse + 1 one-to-one patient reports no spare L3", async () => {
    const sendPush = vi.fn(async () => ({ results: [], goneEndpoints: [] as string[] }));
    const { admin } = fakeAdmin(
      baseTables({
        patient_acuity_overrides: { data: [{ partner_patient_id: "syn-1", level: 2, one_to_one: true }], error: null },
        nurse_staffing: { data: [{ shift: "day", available_nurses: 1 }], error: null },
        nurse_capacity_alert_state: {
          data: { shift_key: "2026-07-10#day", level3_available: true, level2_available: true, level1_available: true, spare: 1 },
          error: null,
        },
      }),
    );
    const out = await checkAndAlertNurseCapacity(admin, NOW, { fetchBoard: boardOf(ONE_PATIENT), sendPush });
    expect(out.kind).toBe("alerted");
    if (out.kind === "alerted") expect(out.levels).toContain("l3");
    const payload = (sendPush.mock.calls[0] as unknown as [unknown, { body: string }])[1];
    expect(payload.body).toMatch(/no spare admissions/);
  });
});
