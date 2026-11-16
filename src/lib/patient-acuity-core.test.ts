import { describe, it, expect, vi } from "vitest";
import { fakeTable } from "@/test-utils/fake-table";
import { runSetPatientAcuity, type AcuityDb } from "./patient-acuity-core";

// Synthetic ids only.
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let tick = 0;
const now = () => new Date(Date.parse("2026-11-16T12:00:00.000Z") + ++tick * 1000);

function db(initial: Array<Record<string, unknown>> = [], clinical: boolean | "error" = true) {
  const t = fakeTable("partner_patient_id", initial);
  const d: AcuityDb = {
    rpc: async () => (clinical === "error" ? { data: null, error: { message: "x" } } : { data: clinical, error: null }),
    from: () => t.table,
  };
  return { d, t };
}
const row = (over: Record<string, unknown> = {}) => ({
  partner_patient_id: PID,
  level: 2,
  level_recorded: true,
  one_to_one: true,
  updated_at: "2026-11-16T11:00:00.000Z",
  updated_by: null,
  ...over,
});

describe("setPatientAcuity fails closed and merges fields", () => {
  it("a failed read of the existing row writes nothing and never clears a recorded 1:1", async () => {
    const { d, t } = db([row()]);
    t.hooks.readError = true;
    const reeval = vi.fn();
    const r = await runSetPatientAcuity(d, USER, { partner_patient_id: PID, level: 3 }, { now, reevaluateCapacity: reeval });
    expect(r.ok).toBe(false);
    expect(t.hooks.writes).toHaveLength(0);
    expect(t.rows[0].one_to_one).toBe(true);
    expect(reeval).not.toHaveBeenCalled();
  });

  it("changing only the level keeps an existing 1:1 (and vice versa)", async () => {
    const { d, t } = db([row()]);
    await runSetPatientAcuity(d, USER, { partner_patient_id: PID, level: 3 }, { now });
    expect(t.rows[0]).toMatchObject({ level: 3, one_to_one: true, level_recorded: true });
    await runSetPatientAcuity(d, USER, { partner_patient_id: PID, one_to_one: false }, { now });
    expect(t.rows[0]).toMatchObject({ level: 3, one_to_one: false });
  });

  it("concurrent level and 1:1 edits preserve each other", async () => {
    const { d, t } = db([row({ level: 1, one_to_one: false })]);
    // Another clinician sets 1:1 between our read and our write.
    t.hooks.beforeMutation = () => {
      Object.assign(t.rows[0], { one_to_one: true, updated_at: "2026-11-16T11:30:00.000Z" });
    };
    const r = await runSetPatientAcuity(d, USER, { partner_patient_id: PID, level: 3 }, { now });
    expect(r.ok).toBe(true);
    expect(t.rows[0]).toMatchObject({ level: 3, one_to_one: true });
  });

  it("an explicit expected revision returns a conflict instead of merging", async () => {
    const { d, t } = db([row()]);
    const r = await runSetPatientAcuity(
      d,
      USER,
      { partner_patient_id: PID, level: 0, expected_updated_at: "2026-11-16T10:00:00.000Z" },
      { now },
    );
    expect(r).toMatchObject({ ok: false, conflict: true });
    expect(t.rows[0].level).toBe(2);
  });

  it("flagging 1:1 with no level never invents an observed L1", async () => {
    const { d, t } = db([]);
    const r = await runSetPatientAcuity(d, USER, { partner_patient_id: PID, one_to_one: true }, { now });
    expect(r.ok && r.entry).toMatchObject({ level: null, one_to_one: true });
    expect(t.rows[0].level_recorded).toBe(false);
  });

  it("clearing the level while 1:1 stays recorded keeps the row with no observed level", async () => {
    const { d, t } = db([row()]);
    const r = await runSetPatientAcuity(d, USER, { partner_patient_id: PID, level: null }, { now });
    expect(r.ok && r.entry).toMatchObject({ level: null, one_to_one: true });
    expect(t.rows).toHaveLength(1);
    const r2 = await runSetPatientAcuity(d, USER, { partner_patient_id: PID, one_to_one: false }, { now });
    expect(r2).toEqual({ ok: true, entry: null });
    expect(t.rows).toHaveLength(0);
  });

  it("re-evaluates capacity once after a successful save, and not when forbidden", async () => {
    const reeval = vi.fn(async () => undefined);
    const ok = db([row()]);
    await runSetPatientAcuity(ok.d, USER, { partner_patient_id: PID, level: 1 }, { now, reevaluateCapacity: reeval });
    expect(reeval).toHaveBeenCalledTimes(1);
    const denied = db([row()], false);
    const r = await runSetPatientAcuity(denied.d, USER, { partner_patient_id: PID, level: 1 }, { now, reevaluateCapacity: reeval });
    expect(r.ok).toBe(false);
    expect(denied.t.hooks.writes).toHaveLength(0);
    expect(reeval).toHaveBeenCalledTimes(1);
  });
});
