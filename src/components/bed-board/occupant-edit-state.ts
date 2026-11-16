/**
 * Edit-patient form state for the Bed Board dialog (pure, testable).
 *
 * The form keeps a BASELINE occupant — the exact Hub revision the user is
 * editing. Every save diffs against that baseline and sends its
 * `updated_at` as `expected_updated_at`. After a 409, "Load latest" moves
 * BOTH the form and the baseline to the Hub's current revision, so the next
 * save is a diff against r2 that sends r2 (not r1 again). Nothing is
 * auto-submitted; only fields the user changes after reviewing are sent.
 */
import type { PartnerOccupant } from "@/lib/partner-bed-board-contract";
import type { UpdatePartnerPatientInput, UpdatePartnerPatientResult } from "@/lib/partner-bed-board.functions";
import { toInitials } from "@/lib/patient-initials";

export type EditForm = {
  full_name: string;
  hospital_number: string;
  age: string;
  bed: string;
  status: "referred" | "admitted" | "discharged" | "died";
  tep_in_place: boolean;
  tep_details: string;
  dnacpr_decision: boolean;
  dnacpr_details: string;
  outstanding_tasks: string;
};

export function occupantToForm(o: PartnerOccupant): EditForm {
  const s = (o.status ?? "admitted") as EditForm["status"];
  return {
    full_name: o.full_name ?? "",
    hospital_number: o.hospital_number ?? "",
    age: o.age != null ? String(o.age) : "",
    bed: o.bed ?? "",
    status: ["referred", "admitted", "discharged", "died"].includes(s) ? s : "admitted",
    tep_in_place: o.tep_in_place === true,
    tep_details: o.tep_details ?? "",
    dnacpr_decision: o.dnacpr_decision === true,
    dnacpr_details: o.dnacpr_details ?? "",
    outstanding_tasks: o.outstanding_tasks ?? "",
  };
}

export function buildDiff(
  initial: EditForm,
  current: EditForm,
  id: string,
  expected_updated_at: string | null,
): UpdatePartnerPatientInput {
  const out: UpdatePartnerPatientInput = { id, expected_updated_at };
  const strKeys = ["full_name", "hospital_number", "bed", "tep_details", "dnacpr_details", "outstanding_tasks"] as const;
  for (const k of strKeys) {
    if (initial[k] !== current[k]) {
      let value: string | null = current[k] === "" ? null : current[k];
      // The Hub "full_name" field carries initials only.
      if (k === "full_name" && typeof value === "string") value = toInitials(value) || null;
      (out as Record<string, unknown>)[k] = value;
    }
  }
  if (initial.age !== current.age) out.age = current.age === "" ? null : Number(current.age);
  if (initial.status !== current.status) out.status = current.status;
  if (initial.tep_in_place !== current.tep_in_place) out.tep_in_place = current.tep_in_place;
  if (initial.dnacpr_decision !== current.dnacpr_decision) out.dnacpr_decision = current.dnacpr_decision;
  return out;
}

export type EditConflict = { current: PartnerOccupant; your_expected_updated_at: string | null };

export type EditState = {
  /** The Hub revision being edited. */
  baseline: PartnerOccupant;
  form: EditForm;
  conflict: EditConflict | null;
};

export const initEditState = (o: PartnerOccupant): EditState => ({ baseline: o, form: occupantToForm(o), conflict: null });

export const hasChanges = (s: EditState) => JSON.stringify(s.form) !== JSON.stringify(occupantToForm(s.baseline));

/** The request a Save sends: diff vs baseline, revision = baseline's. */
export const saveRequest = (s: EditState): UpdatePartnerPatientInput =>
  buildDiff(occupantToForm(s.baseline), s.form, s.baseline.id, s.baseline.updated_at);

export type SaveOutcome = "saved" | "conflict" | "error";

export function applySaveResult(s: EditState, r: UpdatePartnerPatientResult): { state: EditState; outcome: SaveOutcome } {
  if (r.ok) {
    if (r.patient.id !== s.baseline.id) return { state: s, outcome: "error" };
    return { state: initEditState(r.patient), outcome: "saved" };
  }
  if (r.status === 409 && r.conflict && r.conflict.current.id === s.baseline.id) {
    // Keep the user's edits and the old baseline until they choose to review.
    return { state: { ...s, conflict: r.conflict }, outcome: "conflict" };
  }
  return { state: s, outcome: "error" };
}

/** "Load latest": move form AND baseline/revision to the Hub's current row. */
export function loadLatest(s: EditState): EditState {
  if (!s.conflict) return s;
  return initEditState(s.conflict.current);
}
