/**
 * Edit one Hub patient from the bed board. Mounted only while the board is
 * authorised and a patient is selected, keyed by patient + source referral,
 * so switching or closing discards every draft, preview and late reply.
 */

import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Sparkles } from "lucide-react";

import { formatDistanceToNowStrict } from "date-fns";
import { toast } from "sonner";

import { updatePartnerPatient, type PartnerOccupant, type UpdatePartnerPatientInput } from "@/lib/partner-bed-board.functions";
import {
  setPatientAcuity,
  type AcuityLevel,
  type SetPatientAcuityResult,
} from "@/lib/patient-acuity.functions";

import {
  previewPartnerHandoverPrefill,
  applyPartnerHandoverPrefill,
  type PrefillPreviewResult,
} from "@/lib/partner-handover-prefill.functions";

import { toInitials } from "@/lib/patient-initials";
import {
  applySaveResult,
  hasChanges,
  initEditState,
  loadLatest,
  saveRequest,
  type EditForm,
  type EditState,
} from "@/components/bed-board/occupant-edit-state";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { LEVEL_TONE, LEVEL_LABEL } from "@/lib/acuity";

import { useRequestGuard, type RequestTicket } from "@/lib/request-guard";

function formatUpdated(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return "—";
  return formatDistanceToNowStrict(d, { addSuffix: true });
}

export function EditOccupantDialog({
  occupant,
  currentLevel,
  currentOneToOne,
  currentAcuityRevision,
  sourceReferralId,
  onClose,
  onSaved,
  onAcuityChanged,
  onConflictReload,
}: {
  occupant: PartnerOccupant | null;
  currentLevel: AcuityLevel | null;
  currentOneToOne: boolean;
  /** Exact revision of the acuity row (null = none recorded yet). */
  currentAcuityRevision: string | null;
  sourceReferralId: string | null;
  onClose: () => void;
  onSaved: (updated: PartnerOccupant) => void;
  onAcuityChanged: () => void;
  /** Refetch shared Hub data after the user loads the latest revision. */
  onConflictReload: () => void;
}) {
  // Every reply is bound to this patient + referral, the request
  // generation, and the session/clinical epochs; obsolete ones are dropped.
  const guard = useRequestGuard(`${occupant?.id ?? ""}|${sourceReferralId ?? ""}`);
  const save = useServerFn(updatePartnerPatient);
  const saveAcuity = useServerFn(setPatientAcuity);
  const runPreview = useServerFn(previewPartnerHandoverPrefill);
  const runApply = useServerFn(applyPartnerHandoverPrefill);
  // Every acuity save carries the exact revision the clinician saw; the
  // next save uses the revision returned by the previous one.
  const [acuityRev, setAcuityRev] = useState<string | null>(currentAcuityRevision);
  useEffect(() => setAcuityRev(currentAcuityRevision), [currentAcuityRevision, occupant?.id]);
  const afterAcuity = (result: SetPatientAcuityResult, okText: string, t: RequestTicket) => {
    if (!guard.isCurrent(t)) return;
    if (result.ok) {
      setAcuityRev(result.entry?.updated_at ?? null);
      toast.success(okText);
    } else if (result.conflict) {
      setAcuityRev(result.entry ? result.entry.updated_at : result.entry === null ? null : acuityRev);
      toast.warning(result.error);
    } else {
      toast.error(result.error || "Could not save level of care");
    }
    onAcuityChanged();
  };
  type AcuityVars = { t: RequestTicket; id: string; expected: string | null };
  const acuityMutation = useMutation({
    mutationFn: (v: AcuityVars & { level: AcuityLevel | null }) =>
      saveAcuity({ data: { partner_patient_id: v.id, level: v.level, expected_updated_at: v.expected } }),
    onSuccess: (result, v) => afterAcuity(result, "Level of care updated", v.t),
    onError: (err, v) => {
      if (guard.isCurrent(v.t)) toast.error(err instanceof Error ? err.message : "Could not save level");
    },
  });
  const oneToOneMutation = useMutation({
    mutationFn: (v: AcuityVars & { one_to_one: boolean }) =>
      saveAcuity({ data: { partner_patient_id: v.id, one_to_one: v.one_to_one, expected_updated_at: v.expected } }),
    onSuccess: (result, v) => afterAcuity(result, v.one_to_one ? "Marked as 1:1 nursing" : "1:1 nursing cleared", v.t),
    onError: (err, v) => {
      if (guard.isCurrent(v.t)) toast.error(err instanceof Error ? err.message : "Could not update 1:1 nursing");
    },
  });
  // Acuity and 1:1 share one revision chain, so they share one channel.
  const acuityVars = (): AcuityVars | null =>
    occupant ? { t: guard.begin("acuity"), id: occupant.id, expected: acuityRev } : null;
  const setLevel = (level: AcuityLevel | null) => {
    const v = acuityVars();
    if (v) acuityMutation.mutate({ ...v, level });
  };
  const setOneToOne = (one_to_one: boolean) => {
    const v = acuityVars();
    if (v) oneToOneMutation.mutate({ ...v, one_to_one });
  };
  const acuityBusy = acuityMutation.isPending || oneToOneMutation.isPending;

  // Prefill is two explicit steps: preview exactly what would be copied,
  // then apply only after the clinician confirms.
  const [preview, setPreview] = useState<PrefillPreviewResult | null>(null);
  const [prefillProblem, setPrefillProblem] = useState<string | null>(null);
  useEffect(() => {
    setPreview(null);
    setPrefillProblem(null);
  }, [occupant?.id, sourceReferralId]);
  type PrefillVars = { t: RequestTicket; referralId: string; patientId: string };
  const prefillVars = (): PrefillVars | null =>
    occupant && sourceReferralId ? { t: guard.begin("prefill"), referralId: sourceReferralId, patientId: occupant.id } : null;
  const previewMutation = useMutation({
    mutationFn: (v: PrefillVars) => runPreview({ data: { referral_id: v.referralId, partner_patient_id: v.patientId } }),
    onMutate: () => setPrefillProblem(null),
    onSuccess: (r, v) => {
      // Late reply for another patient/referral, a closed dialog, or a
      // previous session/clinical scope: never shown.
      if (!guard.isCurrent(v.t)) return;
      setPreview(r);
      if (!r.ok) setPrefillProblem(r.message);
    },
    onError: (_e, v) => {
      if (guard.isCurrent(v.t)) setPrefillProblem("Could not load the preview. Nothing was copied.");
    },
  });
  const startPreview = () => {
    const v = prefillVars();
    if (v) previewMutation.mutate(v);
  };
  const applyMutation = useMutation({
    mutationFn: (v: PrefillVars & { token: string }) =>
      runApply({ data: { referral_id: v.referralId, partner_patient_id: v.patientId, token: v.token } }),
    onSuccess: (r, v) => {
      if (!guard.isCurrent(v.t)) return;
      if (!r.ok) {
        setPrefillProblem(r.message);
        setPreview(null);
        return;
      }
      setPreview(null);
      toast.success(
        r.applied_fields.length
          ? `Copied ${r.applied_fields.length} referral field${r.applied_fields.length === 1 ? "" : "s"} into ICU Handover Hub for review`
          : "Nothing to copy — those Hub fields already have content",
      );
      onSaved({ ...(occupant as PartnerOccupant), updated_at: r.updated_at ?? (occupant as PartnerOccupant).updated_at });
    },
    onError: (_e, v) => {
      if (guard.isCurrent(v.t)) setPrefillProblem("Could not apply the prefill. Nothing was copied.");
    },
  });
  const startApply = (token: string) => {
    const v = prefillVars();
    if (v) applyMutation.mutate({ ...v, token });
  };
  // Baseline (Hub revision being edited) + form + conflict, see
  // occupant-edit-state.ts. Reset whenever the selected occupant changes.
  const [edit, setEdit] = useState<EditState | null>(occupant ? initEditState(occupant) : null);
  useEffect(() => {
    setEdit(occupant ? initEditState(occupant) : null);
  }, [occupant]);
  const form = edit?.form ?? null;
  const setForm = (f: EditForm) => setEdit((s) => (s ? { ...s, form: f } : s));
  const conflict = edit?.conflict ?? null;

  const mutation = useMutation({
    mutationFn: (v: { t: RequestTicket; input: UpdatePartnerPatientInput }) => save({ data: v.input }),
    onSuccess: (result, v) => {
      if (!guard.isCurrent(v.t) || !edit) return;
      const { state, outcome } = applySaveResult(edit, result);
      setEdit(state);
      if (outcome === "saved" && result.ok) {
        toast.success("Patient updated in ICU Handover Hub");
        onSaved(result.patient);
      } else if (outcome === "conflict") {
        toast.warning("Someone else updated this patient — review the latest values");
      } else {
        toast.error(!result.ok && result.error ? result.error : "Update failed");
      }
    },
    onError: (err, v) => {
      // The draft is kept on failure; only the current dialog reports it.
      if (guard.isCurrent(v.t)) toast.error(err instanceof Error ? err.message : "Update failed");
    },
  });

  const canSubmit = !!occupant && !!edit && hasChanges(edit) && !conflict;

  return (
    <Dialog open={!!occupant} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit patient</DialogTitle>
          <DialogDescription>
            Changes write back to ICU Handover Hub over the signed bridge.
          </DialogDescription>
        </DialogHeader>

        {occupant && sourceReferralId && (
          <div
            className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm"
            role="region"
            aria-label="Prefill handover from referral"
          >
            <div className="flex items-start gap-2">
              <Sparkles className="w-4 h-4 mt-0.5 text-primary" aria-hidden="true" />
              <div className="flex-1 min-w-0">
                <div className="font-medium">Prefill handover from referral</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Copies referral text into BLANK Hub fields only, labelled for clinician review.
                  TEP and DNACPR decisions are never copied or changed.
                </div>
              </div>
              {!(preview && preview.ok) && (
                <Button
                  type="button"
                  size="sm"
                  className="min-h-9"
                  onClick={startPreview}
                  disabled={previewMutation.isPending}
                >
                  {previewMutation.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" aria-hidden="true" />
                  ) : null}
                  {prefillProblem ? "Reload preview" : "Preview"}
                </Button>
              )}
            </div>
            {prefillProblem && (
              <div className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs" role="alert">
                {prefillProblem}
              </div>
            )}
            {preview && preview.ok && (
              <div className="mt-2 space-y-2" aria-live="polite">
                {preview.fields.length === 0 ? (
                  <div className="text-xs text-muted-foreground">
                    Nothing to copy — the matching Hub fields already have content or the referral has none.
                  </div>
                ) : (
                  <ul className="space-y-1.5">
                    {preview.fields.map((f) => (
                      <li key={f.field} className="rounded border bg-background px-2 py-1.5">
                        <div className="text-xs font-medium">{f.label} (currently blank in Hub)</div>
                        <pre className="mt-0.5 whitespace-pre-wrap break-words font-sans text-xs text-muted-foreground">{f.value}</pre>
                      </li>
                    ))}
                  </ul>
                )}
                {preview.skipped_fields.length > 0 && (
                  <div className="text-[11px] text-muted-foreground">
                    Left unchanged (already filled in Hub): {preview.skipped_fields.join(", ").replaceAll("_", " ")}
                  </div>
                )}
                <div className="text-[11px] text-muted-foreground">
                  Patient match confirmed by {preview.link_basis === "source_referral" ? "the Hub referral link" : "an exact hospital-number match"}.
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" className="min-h-9" onClick={() => setPreview(null)}>
                    Cancel
                  </Button>
                  {preview.fields.length > 0 && (
                    <Button
                      type="button"
                      size="sm"
                      className="min-h-9"
                      onClick={() => startApply(preview.token)}
                      disabled={applyMutation.isPending}
                    >
                      {applyMutation.isPending && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" aria-hidden="true" />}
                      Confirm and copy {preview.fields.length} field{preview.fields.length === 1 ? "" : "s"}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {conflict && (
          <div
            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
            role="alert"
          >
            <div className="font-medium flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4" aria-hidden="true" />
              This patient was updated by someone else
            </div>
            <div className="text-xs mt-1 text-muted-foreground">
              Your edits are still shown but were not saved. Load the latest
              Hub values, then re-apply your changes and save again.
            </div>
            <div className="mt-2 flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => {
                  setEdit((s) => (s ? loadLatest(s) : s));
                  onConflictReload();
                }}
              >
                Load latest
              </Button>
            </div>
          </div>
        )}

        {occupant && (
          <div className="rounded-md border px-3 py-2">
            <div className="flex items-center justify-between gap-2 mb-2">
              <Label className="text-sm">Level of care</Label>
              {currentLevel != null && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 disabled:opacity-50"
                  disabled={acuityBusy}
                  onClick={() => setLevel(null)}
                >
                  Clear
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {([0, 1, 2, 3] as const).map((l) => {
                const selected = currentLevel === l;
                return (
                  <button
                    key={l}
                    type="button"
                    disabled={acuityBusy}
                    onClick={() => setLevel(l)}
                    className={`rounded-md border px-3 py-1.5 text-sm transition disabled:opacity-50 ${
                      selected ? LEVEL_TONE[l] + " ring-2 ring-offset-1 ring-current" : "hover:bg-accent"
                    }`}
                    title={LEVEL_LABEL[l]}
                    aria-pressed={selected}
                    aria-label={LEVEL_LABEL[l]}
                  >
                    L{l}
                  </button>
                );
              })}
            </div>
            <div className="mt-3 flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-2.5 py-2">
              <div className="min-w-0">
                <Label htmlFor="one-to-one-switch" className="text-sm">
                  Requires 1:1 nursing
                </Label>
                <div className="text-[11px] text-muted-foreground">
                  Forces this patient to count as a full nurse in unit dependency,
                  regardless of level of care.
                </div>
              </div>
              <Switch
                id="one-to-one-switch"
                checked={currentOneToOne}
                disabled={acuityBusy}
                onCheckedChange={(v) => setOneToOne(v === true)}
                aria-label="Requires 1:1 nursing"
              />
            </div>
            <div className="text-[11px] text-muted-foreground mt-1.5">
              Level of care is stored in this app and feeds unit acuity. Other
              patient details write back to ICU Handover Hub.
            </div>
          </div>
        )}

        {occupant && form && (
          <form
            className="grid grid-cols-2 gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!edit || !canSubmit) return;
              mutation.mutate({ t: guard.begin("save"), input: saveRequest(edit) });
            }}
          >
            <div className="col-span-2">
              <Label htmlFor="full_name">Patient initials</Label>
              <Input
                id="full_name"
                value={form.full_name}
                onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                onBlur={(e) => setForm({ ...form, full_name: toInitials(e.target.value) })}
                maxLength={40}
                placeholder="e.g. JS"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Initials only (max 10 letters). Full names are automatically converted
                before saving and sharing with ICU Handover Hub over the signed bridge.
              </p>
            </div>
            <div>
              <Label htmlFor="hospital_number">Hospital #</Label>
              <Input
                id="hospital_number"
                value={form.hospital_number}
                onChange={(e) =>
                  setForm({ ...form, hospital_number: e.target.value })
                }
              />
            </div>
            <div>
              <Label htmlFor="age">Age</Label>
              <Input
                id="age"
                type="number"
                min={0}
                max={130}
                value={form.age}
                onChange={(e) => setForm({ ...form, age: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="bed">Bed</Label>
              <Input
                id="bed"
                value={form.bed}
                onChange={(e) => setForm({ ...form, bed: e.target.value })}
                placeholder="e.g. 4 or SR1"
              />
            </div>
            <div>
              <Label htmlFor="status">Status</Label>
              <Select
                value={form.status}
                onValueChange={(v) =>
                  setForm({ ...form, status: v as EditForm["status"] })
                }
              >
                <SelectTrigger id="status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="referred">Referred</SelectItem>
                  <SelectItem value="admitted">Admitted</SelectItem>
                  <SelectItem value="discharged">Discharged</SelectItem>
                  <SelectItem value="died">Died</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="col-span-2 flex items-center justify-between border rounded-md px-3 py-2">
              <Label htmlFor="tep_in_place" className="flex-1">
                TEP in place
              </Label>
              <Switch
                id="tep_in_place"
                checked={form.tep_in_place}
                onCheckedChange={(v) => setForm({ ...form, tep_in_place: v })}
              />
            </div>
            {form.tep_in_place && (
              <div className="col-span-2">
                <Label htmlFor="tep_details">TEP details</Label>
                <Textarea
                  id="tep_details"
                  rows={2}
                  value={form.tep_details}
                  onChange={(e) =>
                    setForm({ ...form, tep_details: e.target.value })
                  }
                />
              </div>
            )}

            <div className="col-span-2 flex items-center justify-between border rounded-md px-3 py-2">
              <Label htmlFor="dnacpr" className="flex-1">
                DNACPR decision
              </Label>
              <Switch
                id="dnacpr"
                checked={form.dnacpr_decision}
                onCheckedChange={(v) =>
                  setForm({ ...form, dnacpr_decision: v })
                }
              />
            </div>
            {form.dnacpr_decision && (
              <div className="col-span-2">
                <Label htmlFor="dnacpr_details">DNACPR details</Label>
                <Textarea
                  id="dnacpr_details"
                  rows={2}
                  value={form.dnacpr_details}
                  onChange={(e) =>
                    setForm({ ...form, dnacpr_details: e.target.value })
                  }
                />
              </div>
            )}

            <div className="col-span-2">
              <Label htmlFor="tasks">Outstanding tasks</Label>
              <Textarea
                id="tasks"
                rows={3}
                value={form.outstanding_tasks}
                onChange={(e) =>
                  setForm({ ...form, outstanding_tasks: e.target.value })
                }
              />
            </div>

            <DialogFooter className="col-span-2 mt-2">
              <div className="text-xs text-muted-foreground mr-auto self-center">
                Last updated {formatUpdated(edit?.baseline.updated_at ?? occupant.updated_at)}
              </div>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canSubmit || mutation.isPending}>
                {mutation.isPending && (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" aria-hidden="true" />
                )}
                Save changes
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

