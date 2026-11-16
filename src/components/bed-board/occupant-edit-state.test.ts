/**
 * Bed Board edit conflict recovery: after a 409, "Load latest" must move
 * both the form AND the target revision to r2. Synthetic data only.
 */
import { describe, it, expect } from "vitest";
import type { PartnerOccupant } from "@/lib/partner-bed-board-contract";
import { applySaveResult, hasChanges, initEditState, loadLatest, saveRequest } from "./occupant-edit-state";

const ID = "00000000-0000-4000-8000-000000000042";
const occ = (rev: string, over: Partial<PartnerOccupant> = {}): PartnerOccupant => ({
  id: ID,
  full_name: "AB",
  hospital_number: "SYN001",
  age: 70,
  status: "admitted",
  bed: "3",
  admission_date: null,
  tep_in_place: false,
  dnacpr_decision: false,
  dnacpr_details: null,
  tep_details: null,
  outstanding_tasks: null,
  updated_at: rev,
  ...over,
});
const R1 = "2026-11-16T10:00:00.000001+00:00";
const R2 = "2026-11-16T10:05:00.000002+00:00";
const R3 = "2026-11-16T10:06:00.000003+00:00";

describe("edit conflict recovery", () => {
  it("r1 → 409(r2) → Load latest → edit → request carries expected r2 and only the new edit", () => {
    let s = initEditState(occ(R1));
    s = { ...s, form: { ...s.form, outstanding_tasks: "my edit on r1" } };
    expect(saveRequest(s)).toEqual({ id: ID, expected_updated_at: R1, outstanding_tasks: "my edit on r1" });

    const r2 = occ(R2, { bed: "4", tep_in_place: true });
    const first = applySaveResult(s, { ok: false, status: 409, error: "x", conflict: { current: r2, your_expected_updated_at: R1 } });
    expect(first.outcome).toBe("conflict");
    // Nothing auto-applied: the user's edit and the old baseline remain until review.
    expect(first.state.baseline.updated_at).toBe(R1);
    expect(first.state.form.outstanding_tasks).toBe("my edit on r1");

    let next = loadLatest(first.state);
    expect(next.conflict).toBeNull();
    expect(next.baseline.updated_at).toBe(R2);
    expect(next.form).toMatchObject({ bed: "4", tep_in_place: true, outstanding_tasks: "" });
    expect(hasChanges(next)).toBe(false); // no autosubmit, nothing to send yet

    next = { ...next, form: { ...next.form, outstanding_tasks: "re-applied on r2" } };
    // Fields changed by the other user (bed, TEP) are NOT re-sent / overwritten.
    expect(saveRequest(next)).toEqual({ id: ID, expected_updated_at: R2, outstanding_tasks: "re-applied on r2" });
  });

  it("a repeated conflict (r3) after loading r2 moves the target to r3", () => {
    let s = loadLatest({ ...initEditState(occ(R1)), conflict: { current: occ(R2), your_expected_updated_at: R1 } });
    s = { ...s, form: { ...s.form, age: "71" } };
    const again = applySaveResult(s, { ok: false, status: 409, error: "x", conflict: { current: occ(R3, { age: 72 }), your_expected_updated_at: R2 } });
    const s3 = loadLatest(again.state);
    expect(s3.baseline.updated_at).toBe(R3);
    expect(saveRequest({ ...s3, form: { ...s3.form, status: "discharged" } })).toEqual({
      id: ID,
      expected_updated_at: R3,
      status: "discharged",
    });
  });

  it("explicit false is preserved: only changed booleans are sent", () => {
    let s = initEditState(occ(R1, { dnacpr_decision: false, tep_in_place: false }));
    s = { ...s, form: { ...s.form, outstanding_tasks: "x" } };
    const req = saveRequest(s);
    expect(req).not.toHaveProperty("dnacpr_decision");
    expect(req).not.toHaveProperty("tep_in_place");
  });

  it("role denied / sharing revoked / a conflict row for another patient change nothing", () => {
    const s = { ...initEditState(occ(R1)), form: { ...initEditState(occ(R1)).form, bed: "9" } };
    for (const r of [
      { ok: false as const, status: 403, error: "denied" },
      { ok: false as const, status: 404, error: "not shared" },
      { ok: false as const, status: 409, error: "x", conflict: { current: occ(R2, { id: "00000000-0000-4000-8000-000000000099" }), your_expected_updated_at: R1 } },
    ]) {
      const out = applySaveResult(s, r);
      expect(out.outcome).toBe("error");
      expect(out.state).toBe(s);
    }
  });

  it("a successful save rebases on the returned revision", () => {
    const s = initEditState(occ(R1));
    const out = applySaveResult({ ...s, form: { ...s.form, bed: "5" } }, { ok: true, patient: occ(R2, { bed: "5" }) });
    expect(out.outcome).toBe("saved");
    expect(out.state.baseline.updated_at).toBe(R2);
    expect(hasChanges(out.state)).toBe(false);
  });
});
