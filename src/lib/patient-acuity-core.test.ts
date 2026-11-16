import { describe, it, expect, vi } from "vitest";
import { fakeTable } from "@/test-utils/fake-table";
import {
  nextRevisionStamp,
  revisionMicros,
  runSetPatientAcuity,
  validateAcuityInput,
  type AcuityDb,
} from "./patient-acuity-core";

// Synthetic ids only.
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const now = () => new Date("2026-11-16T12:00:00.000Z");

function db(initial: Array<Record<string, unknown>> = [], clinical: boolean | "error" = true) {
  const t = fakeTable("partner_patient_id", initial);
  const d: AcuityDb = {
    rpc: async () => (clinical === "error" ? { data: null, error: { message: "x" } } : { data: clinical, error: null }),
    from: () => t.table,
  };
  return { d, t };
}
const R1 = "2026-11-16T11:00:00.123001+00:00";
const row = (over: Record<string, unknown> = {}) => ({
  partner_patient_id: PID,
  level: 2,
  level_recorded: true,
  one_to_one: true,
  updated_at: R1,
  updated_by: null,
  ...over,
});
const set = (d: AcuityDb, input: Record<string, unknown>, reeval?: () => Promise<unknown>) =>
  runSetPatientAcuity(d, USER, { partner_patient_id: PID, ...input } as never, { now, reevaluateCapacity: reeval });

describe("acuity revision is compared at full database precision", () => {
  it(".123001 vs .123999 (same millisecond) is a conflict, and nothing is written", async () => {
    const { d, t } = db([row({ updated_at: "2026-11-16T11:00:00.123999+00:00" })]);
    const r = await set(d, { level: 3, expected_updated_at: R1 });
    expect(r).toMatchObject({ ok: false, conflict: true, entry: { level: 2, updated_at: "2026-11-16T11:00:00.123999+00:00" } });
    expect(t.hooks.writes).toHaveLength(0);
    expect(t.rows[0].level).toBe(2);
  });

  it("the write is a CAS on the SUPPLIED revision, not on a freshly read one", async () => {
    const { d, t } = db([row()]);
    // Another edit lands between our read and our write.
    t.hooks.beforeMutation = () => Object.assign(t.rows[0], { one_to_one: false, updated_at: "2026-11-16T11:00:00.123002+00:00" });
    const r = await set(d, { level: 3, expected_updated_at: R1 });
    expect(r).toMatchObject({ ok: false, conflict: true, entry: { one_to_one: false } });
    expect(t.rows[0]).toMatchObject({ level: 2, one_to_one: false });
  });

  it("a missing expected revision is rejected before anything is read or written", () => {
    expect(() => validateAcuityInput({ partner_patient_id: PID, level: 1 } as never)).toThrow(/expected_updated_at is required/);
    expect(() => validateAcuityInput({ partner_patient_id: PID, level: 1, expected_updated_at: "yesterday" })).toThrow();
  });

  it("each save moves the revision strictly forward, even within the same millisecond", () => {
    const same = nextRevisionStamp(new Date("2026-11-16T11:00:00.123Z"), "2026-11-16T11:00:00.123999+00:00");
    expect(same).toBe("2026-11-16T11:00:00.124000+00:00");
    expect(revisionMicros(same)! > revisionMicros("2026-11-16T11:00:00.123999+00:00")!).toBe(true);
    expect(nextRevisionStamp(new Date("2026-11-16T12:00:00.000Z"), R1)).toBe("2026-11-16T12:00:00.000000+00:00");
  });
});

describe("setPatientAcuity fails closed and preserves fields", () => {
  it("a failed read writes nothing, never clears a recorded 1:1, and does not re-evaluate capacity", async () => {
    const { d, t } = db([row()]);
    t.hooks.readError = true;
    const reeval = vi.fn();
    const r = await set(d, { level: 3, expected_updated_at: R1 }, reeval);
    expect(r.ok).toBe(false);
    expect(t.hooks.writes).toHaveLength(0);
    expect(t.rows[0].one_to_one).toBe(true);
    expect(reeval).not.toHaveBeenCalled();
  });

  it("changing only the level keeps 1:1; then explicit one_to_one:false is stored as false", async () => {
    const { d, t } = db([row()]);
    const r1 = await set(d, { level: 3, expected_updated_at: R1 });
    expect(r1.ok).toBe(true);
    expect(t.rows[0]).toMatchObject({ level: 3, one_to_one: true, level_recorded: true, updated_by: USER });
    const rev2 = t.rows[0].updated_at as string;
    expect(rev2).not.toBe(R1);
    const r2 = await set(d, { one_to_one: false, expected_updated_at: rev2 });
    expect(r2.ok).toBe(true);
    expect(t.rows[0]).toMatchObject({ level: 3, one_to_one: false });
  });

  it("concurrent partial edits from the same revision: first wins, second gets an explicit conflict with the latest", async () => {
    const { d, t } = db([row({ level: 1, one_to_one: false })]);
    const a = await runSetPatientAcuity(d, OTHER, { partner_patient_id: PID, one_to_one: true, expected_updated_at: R1 }, { now });
    expect(a.ok).toBe(true);
    const b = await set(d, { level: 3, expected_updated_at: R1 });
    expect(b).toMatchObject({ ok: false, conflict: true, entry: { level: 1, one_to_one: true } });
    // After reviewing the latest revision, the level edit applies and keeps 1:1.
    const latest = !b.ok && b.entry ? b.entry.updated_at : "";
    const c = await set(d, { level: 3, expected_updated_at: latest });
    expect(c.ok).toBe(true);
    expect(t.rows[0]).toMatchObject({ level: 3, one_to_one: true });
  });

  it("creation with 'no row expected' conflicts if a row now exists (including a racing insert)", async () => {
    const { d, t } = db([row()]);
    expect(await set(d, { level: 1, expected_updated_at: null })).toMatchObject({ ok: false, conflict: true });
    expect(t.hooks.writes).toHaveLength(0);
    const e = db([]);
    e.t.hooks.beforeMutation = () => e.t.rows.push(row({ updated_at: "2026-11-16T11:59:00.000001+00:00" }));
    expect(await set(e.d, { level: 1, expected_updated_at: null })).toMatchObject({ ok: false, conflict: true, entry: { level: 2 } });
    expect(e.t.rows).toHaveLength(1);
  });

  it("an existing-row revision for a row that has gone is a conflict, not a silent create", async () => {
    const { d, t } = db([]);
    expect(await set(d, { level: 2, expected_updated_at: R1 })).toMatchObject({ ok: false, conflict: true, entry: null });
    expect(t.rows).toHaveLength(0);
  });

  it("flagging 1:1 on a new patient never invents an observed level", async () => {
    const { d, t } = db([]);
    const r = await set(d, { one_to_one: true, expected_updated_at: null });
    expect(r).toMatchObject({ ok: true, entry: { level: null, one_to_one: true } });
    expect(t.rows[0]).toMatchObject({ level_recorded: false, one_to_one: true });
  });

  it("clearing the last recorded field deletes only the expected revision", async () => {
    const { d, t } = db([row({ one_to_one: false })]);
    expect(await set(d, { level: null, expected_updated_at: "2026-11-16T11:00:00.123999+00:00" })).toMatchObject({ conflict: true });
    expect(t.rows).toHaveLength(1);
    expect(await set(d, { level: null, expected_updated_at: R1 })).toMatchObject({ ok: true, entry: null });
    expect(t.rows).toHaveLength(0);
  });

  it("permission check failure or non-clinical caller changes nothing", async () => {
    for (const c of ["error", false] as const) {
      const { d, t } = db([row()], c);
      expect((await set(d, { level: 3, expected_updated_at: R1 })).ok).toBe(false);
      expect(t.hooks.writes).toHaveLength(0);
    }
  });

  it("successful save re-evaluates capacity; a failing re-evaluation never breaks the save", async () => {
    const { d } = db([row()]);
    const reeval = vi.fn(async () => {
      throw new Error("alerts down");
    });
    expect((await set(d, { level: 3, expected_updated_at: R1 }, reeval)).ok).toBe(true);
    expect(reeval).toHaveBeenCalledTimes(1);
  });
});
