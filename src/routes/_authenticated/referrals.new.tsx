import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { createReferral, findReferralsByHospitalNumber } from "@/lib/referrals.functions";
import { RouteErrorFallback } from "@/components/route-error-fallback";
import { ClinicalAccessGate } from "@/components/clinical-access-gate";
import { ReferralRouteError } from "@/components/referral-route-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertCircle } from "lucide-react";
import { ComboboxAdd } from "@/components/combobox-add";
import { useReferralOptions } from "@/hooks/use-referral-options";
import { toast } from "sonner";
import { format } from "date-fns";
import { validateReferralAll, validateReferralTimings } from "@/lib/referral-validation";
import {
  ADMISSION_URGENCY_OPTIONS,
  type AdmissionUrgency,
} from "@/lib/admission-urgency";
import { cn } from "@/lib/utils";
import {
  blankForm,
  DRAFT_KEY,
  DRAFT_SAFE_VERSION,
  isSafeDraftDirty,
  localISO,
  SENSITIVE_DRAFT_KEYS,
  toSafeDraft,
  type DraftForm,
  type SafeDraft,
} from "@/lib/referral-draft";
import { DateTimeNow, Field, Section } from "@/components/referrals/referral-form-fields";
import {
  PriorReferralsAlert,
  PriorReferralsDialog,
  type PriorReferral,
} from "@/components/referrals/prior-referrals-dialog";
import {
  ClinicalFields,
  emptyClinicalFields,
  type ClinicalFieldsValue,
} from "@/components/referrals/clinical-fields";
import { OutcomeSelector } from "@/components/referrals/outcome-selector";
import { validateReferralOutcome, type ReferralOutcome } from "@/lib/referral-outcome";


export const Route = createFileRoute("/_authenticated/referrals/new")({
  head: () => ({ meta: [{ title: "New referral — SDH Critical Care" }] }),
  errorComponent: ({ error }) => <ReferralRouteError error={error} label="New referral" />,
  component: NewReferralPage,
});

function NewReferralPage() {
  const navigate = useNavigate();
  const create = useServerFn(createReferral);
  const [saving, setSaving] = useState(false);
  const { specialties, wards, consultants } = useReferralOptions();
  const [f, setF] = useState<DraftForm>(blankForm);
  // Clinical-assessment state kept OUT of the persisted draft — although not
  // directly identifying, these fields are patient-specific and should not
  // survive across sessions in browser storage.
  const [clinical, setClinical] = useState<ClinicalFieldsValue>(emptyClinicalFields);
  const [outcome, setOutcome] = useState<ReferralOutcome | null>(null);
  const [previousReferralId, setPreviousReferralId] = useState<string | null>(null);
  const [draftRestored, setDraftRestored] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState<Date | null>(null);


  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as SafeDraft & Partial<DraftForm>;
      if (parsed && parsed.__v !== DRAFT_SAFE_VERSION) {
        window.localStorage.removeItem(DRAFT_KEY);
        return;
      }
      const { __v: _v, ...safe } = parsed;
      for (const k of SENSITIVE_DRAFT_KEYS) {
        delete (safe as Partial<DraftForm>)[k];
      }
      const restored: DraftForm = { ...blankForm(), ...(safe as Partial<DraftForm>) };
      if (isSafeDraftDirty(restored)) {
        setF(restored);
        setDraftRestored(true);
        toast.info("Restored your in-progress referral draft. Patient details were not saved and must be re-entered.");
      }
    } catch {
      // ignore corrupt draft
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const t = setTimeout(() => {
      try {
        if (isSafeDraftDirty(f)) {
          window.localStorage.setItem(DRAFT_KEY, JSON.stringify(toSafeDraft(f)));
          setDraftSavedAt(new Date());
        } else {
          window.localStorage.removeItem(DRAFT_KEY);
        }
      } catch {
        // storage full / disabled — ignore
      }
    }, 400);
    return () => clearTimeout(t);
  }, [f]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (e: BeforeUnloadEvent) => {
      if (isSafeDraftDirty(f)) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [f]);

  const discardDraft = () => {
    if (typeof window !== "undefined") window.localStorage.removeItem(DRAFT_KEY);
    setF(blankForm());
    setDraftRestored(false);
    setDraftSavedAt(null);
    toast.success("Draft discarded.");
  };

  const set = <K extends keyof DraftForm>(k: K, v: DraftForm[K]) =>
    setF((cur) => ({ ...cur, [k]: v }));

  // Prior-referral lookup by hospital number
  const findPrior = useServerFn(findReferralsByHospitalNumber);
  const [priors, setPriors] = useState<PriorReferral[]>([]);
  const [priorOpen, setPriorOpen] = useState(false);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);

  useEffect(() => {
    const hn = f.hospital_number.trim();
    if (!hn) {
      setPriors([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await findPrior({ data: { hospital_number: hn } });
        if (!cancelled) setPriors((res ?? []) as unknown as PriorReferral[]);
      } catch {
        if (!cancelled) setPriors([]);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [f.hospital_number, findPrior]);

  const priorC2C = priors.some((p) => p.consultant_to_consultant_only === true);

  useEffect(() => {
    if (priorC2C && !f.consultant_to_consultant_only) {
      setF((cur) => ({ ...cur, consultant_to_consultant_only: true }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priorC2C]);

  const showAlert =
    priors.length > 0 && dismissedFor !== f.hospital_number.trim();

  const priorWithHistory = priors.find(
    (p) => (p.past_medical_history && p.past_medical_history.trim()) ||
           (p.baseline_function && p.baseline_function.trim()),
  );

  const autofillPMH = () => {
    if (!priorWithHistory) return;
    const incomingPMH = priorWithHistory.past_medical_history?.trim() ?? "";
    const incomingBaseline = priorWithHistory.baseline_function?.trim() ?? "";
    const hasExisting =
      (f.past_medical_history.trim() && incomingPMH && f.past_medical_history.trim() !== incomingPMH) ||
      (f.baseline_function.trim() && incomingBaseline && f.baseline_function.trim() !== incomingBaseline);
    if (hasExisting) {
      const ok = typeof window !== "undefined"
        ? window.confirm("Overwrite the past medical history / baseline function you've already entered with the previous referral's values?")
        : true;
      if (!ok) return;
    }
    setF((cur) => ({
      ...cur,
      past_medical_history: incomingPMH || cur.past_medical_history,
      baseline_function: incomingBaseline || cur.baseline_function,
    }));
    toast.success("Past medical history auto-filled from previous referral.");
  };

  const timing = validateReferralTimings({
    status: f.status,
    referral_received_at: f.referral_received_at
      ? new Date(f.referral_received_at).toISOString()
      : null,
    first_seen_at: f.first_seen_at ? new Date(f.first_seen_at).toISOString() : null,
    decision_at: f.decision_at ? new Date(f.decision_at).toISOString() : null,
    arrived_on_unit_at: f.arrived_on_unit_at
      ? new Date(f.arrived_on_unit_at).toISOString()
      : null,
  });
  const [showErrors, setShowErrors] = useState(false);

  const declineReasonMissing =
    f.status === "declined" && !f.decline_reason.trim();
  const declineConsultantMissing =
    f.status === "declined" && !f.discussed_with_consultant.trim();
  const acceptingConsultantMissing =
    (f.status === "admitted" || f.status === "accepted") && !f.accepting_consultant.trim();

  const combined = validateReferralAll({
    status: f.status,
    referral_received_at: f.referral_received_at
      ? new Date(f.referral_received_at).toISOString()
      : null,
    first_seen_at: f.first_seen_at ? new Date(f.first_seen_at).toISOString() : null,
    decision_at: f.decision_at ? new Date(f.decision_at).toISOString() : null,
    arrived_on_unit_at: f.arrived_on_unit_at
      ? new Date(f.arrived_on_unit_at).toISOString()
      : null,
    decline_reason: f.decline_reason,
    discussed_with_consultant: f.discussed_with_consultant,
    accepting_consultant: f.accepting_consultant,
    admission_urgency: f.admission_urgency || null,
  });

  const outcomeCheck = validateReferralOutcome({
    outcome,
    ceiling_of_care: clinical.ceiling_of_care,
    reason_notes: f.reason_for_referral,
    decline_reason: f.decline_reason,
    discussed_with_consultant: f.discussed_with_consultant,
    accepting_consultant: f.accepting_consultant,
    first_seen_at: f.first_seen_at || null,
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!combined.isValid) {
      setShowErrors(true);
      const firstFieldError = Object.values(combined.fieldErrors)[0];
      toast.error(firstFieldError ?? combined.issues[0] ?? "Please fix the highlighted fields before saving.");
      return;
    }
    if (!outcomeCheck.isValid) {
      setShowErrors(true);
      const first = Object.values(outcomeCheck.fieldErrors)[0];
      toast.error(first ?? "Please complete the outcome fields.");
      return;
    }




    setSaving(true);
    try {
      const payload: any = {
        ...f,
        age: f.age ? Number(f.age) : null,
        referral_received_at: new Date(f.referral_received_at).toISOString(),
        first_seen_at: f.first_seen_at ? new Date(f.first_seen_at).toISOString() : null,
        decision_at: f.decision_at ? new Date(f.decision_at).toISOString() : null,
        arrived_on_unit_at: f.arrived_on_unit_at ? new Date(f.arrived_on_unit_at).toISOString() : null,
        admission_urgency: f.admission_urgency || null,
        // Point-2 clinical fields
        news2_score: clinical.news2_score,
        news2_recorded_at: clinical.news2_score != null ? new Date().toISOString() : null,
        ceiling_of_care: clinical.ceiling_of_care,
        reason_category: clinical.reason_category,
        frailty_score: clinical.frailty_score,
        anticipated_interventions: clinical.anticipated_interventions,
        infection_status: clinical.infection_status,
        infection_organism: clinical.infection_organism,
        weight_kg: clinical.weight_kg,
        allergies: clinical.allergies,
        resus_status: clinical.resus_status,
        needs_ward_review: clinical.needs_ward_review,
        for_ongoing_ccot_review: clinical.for_ongoing_ccot_review,
        ward_review_timeframe: clinical.ward_review_timeframe,
        outcome,
        previous_referral_id: previousReferralId,
      };
      for (const k of [
        "hospital_number","current_ward","current_bed","past_medical_history",
        "baseline_function","referring_specialty","reason_for_referral","decline_reason","discussed_with_consultant","accepting_consultant",
      ]) if (!payload[k]) payload[k] = null;


      const res = await create({ data: payload });
      if (typeof window !== "undefined") window.localStorage.removeItem(DRAFT_KEY);
      toast.success("Referral saved");
      navigate({ to: "/referrals/$id", params: { id: (res as any).id } });
    } catch (err: any) {
      toast.error(err.message ?? "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ClinicalAccessGate>
    <div className="p-4 sm:p-6 max-w-3xl mx-auto">
      <div className="flex items-end justify-between mb-6 gap-4 flex-wrap">
        <h1 className="text-2xl font-semibold tracking-tight">New referral</h1>
        {(draftRestored || draftSavedAt) && isSafeDraftDirty(f) && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>
              {draftRestored ? "Draft restored" : "Draft auto-saved"}
              {draftSavedAt ? ` · ${format(draftSavedAt, "HH:mm:ss")}` : ""}
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={discardDraft}>
              Discard draft
            </Button>
          </div>
        )}
      </div>
      <form onSubmit={submit} className="space-y-6">
        <Section title="Patient">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Age"><Input type="number" min="0" max="130" value={f.age} onChange={(e) => set("age", e.target.value)} /></Field>
            <Field label="Sex">
              <Select value={f.sex} onValueChange={(v) => set("sex", v as DraftForm["sex"])}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="male">Male</SelectItem>
                  <SelectItem value="female">Female</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                  <SelectItem value="unknown">Unknown</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Hospital number"><Input value={f.hospital_number} onChange={(e) => set("hospital_number", e.target.value)} /></Field>
            <Field label="Patient initials"><Input value={f.patient_initials} maxLength={10} placeholder="e.g. J.S." onChange={(e) => set("patient_initials", e.target.value)} /></Field>
            <Field label="Referring specialty"><ComboboxAdd value={f.referring_specialty} onChange={(v) => set("referring_specialty", v)} options={specialties} placeholder="e.g. General Surgery" /></Field>
            <Field label="Current ward"><ComboboxAdd value={f.current_ward} onChange={(v) => set("current_ward", v)} options={wards} placeholder="e.g. ED Resus, Pembroke" /></Field>
            <Field label="Bed"><Input value={f.current_bed} onChange={(e) => set("current_bed", e.target.value)} /></Field>
          </div>
          <PriorReferralsAlert
            hospitalNumber={f.hospital_number}
            priors={priors}
            priorC2C={priorC2C}
            showAlert={showAlert}
            priorWithHistory={priorWithHistory}
            onOpenDialog={() => setPriorOpen(true)}
            onAutofillPMH={autofillPMH}
            onDismiss={() => setDismissedFor(f.hospital_number.trim())}
          />
        </Section>

        <Section title="Timestamps">
          <p className="text-xs text-muted-foreground -mt-2">
            ICNARC requires referral received for every record. First seen and decision are required once the patient has been reviewed; arrival is required for admitted patients.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Referral received" required error={showErrors ? timing.fieldErrors.referral_received_at : undefined}>
              <DateTimeNow value={f.referral_received_at} onChange={(v) => set("referral_received_at", v)} invalid={showErrors && !!timing.fieldErrors.referral_received_at} />
            </Field>
            <Field label="First seen by CC" required={f.status !== "pending"} error={showErrors ? timing.fieldErrors.first_seen_at : undefined}>
              <DateTimeNow value={f.first_seen_at} onChange={(v) => set("first_seen_at", v)} invalid={showErrors && !!timing.fieldErrors.first_seen_at} />
            </Field>
            <Field label="Decision to admit / decline" required={f.status !== "pending"} error={showErrors ? timing.fieldErrors.decision_at : undefined}>
              <DateTimeNow value={f.decision_at} onChange={(v) => set("decision_at", v)} invalid={showErrors && !!timing.fieldErrors.decision_at} />
            </Field>
            <Field label="Arrived on unit" required={f.status === "admitted"} error={showErrors ? timing.fieldErrors.arrived_on_unit_at : undefined}>
              <DateTimeNow value={f.arrived_on_unit_at} onChange={(v) => set("arrived_on_unit_at", v)} invalid={showErrors && !!timing.fieldErrors.arrived_on_unit_at} />
            </Field>
          </div>
          {showErrors && timing.issues.length > 0 && (
            <Alert variant="destructive" className="mt-2">
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              <AlertTitle>Inconsistent timings</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4 space-y-1">
                  {timing.issues.map((m) => <li key={m}>{m}</li>)}
                </ul>
              </AlertDescription>
            </Alert>
          )}
        </Section>

        <Section title="Clinical">
          <Field label="Past medical history"><Textarea rows={3} value={f.past_medical_history} onChange={(e) => set("past_medical_history", e.target.value)} /></Field>
          <Field label="Baseline level of function"><Textarea rows={2} value={f.baseline_function} onChange={(e) => set("baseline_function", e.target.value)} placeholder="e.g. independent, MRC dyspnoea 2, lives alone" /></Field>
          <Field label="Reason for referral"><Textarea rows={3} value={f.reason_for_referral} onChange={(e) => set("reason_for_referral", e.target.value)} /></Field>
          <div className="flex items-center gap-3">
            <Switch id="dnacpr" checked={f.dnacpr_respect} onCheckedChange={(v) => set("dnacpr_respect", v)} />
            <Label htmlFor="dnacpr">DNACPR / ReSPECT form already in place</Label>
          </div>
          <div className="flex items-center gap-3">
            <Switch
              id="c2c"
              checked={f.consultant_to_consultant_only}
              onCheckedChange={(v) => set("consultant_to_consultant_only", v)}
            />
            <Label htmlFor="c2c">Consultant-to-consultant referral only</Label>
          </div>
          <div className="flex items-start justify-between gap-4 rounded-md border border-warning/60 bg-warning/10 p-3">
            <div>
              <Label htmlFor="is-test" className="text-sm font-medium cursor-pointer">
                Test / demonstration referral
              </Label>
              <p className="text-xs text-muted-foreground">
                Mark as a test entry (not a real patient). Test referrals show a
                badge on the list and are excluded from analytics.
              </p>
            </div>
            <Switch
              id="is-test"
              checked={f.is_test}
              onCheckedChange={(v) => set("is_test", v)}
            />
          </div>
        </Section>

        <Section title="Clinical assessment">
          <ClinicalFields
            value={clinical}
            onChange={(patch) => setClinical((cur) => ({ ...cur, ...patch }))}
            age={f.age ? Number(f.age) : null}
            errors={showErrors ? (outcomeCheck.fieldErrors as Partial<Record<keyof ClinicalFieldsValue, string>>) : undefined}
          />
        </Section>

        <Section title="Outcome">
          <OutcomeSelector value={outcome} onChange={setOutcome} />
          {priors.length > 0 && (
            <div className="rounded-md border bg-muted/40 p-3 flex items-center justify-between gap-3">
              <div className="text-sm">
                {previousReferralId ? (
                  <>Linked to previous referral <span className="font-mono text-xs">#{previousReferralId.slice(0, 8)}</span>.</>
                ) : (
                  <>This patient has {priors.length} earlier referral{priors.length === 1 ? "" : "s"}. Link this as a re-referral?</>
                )}
              </div>
              {previousReferralId ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => setPreviousReferralId(null)}>
                  Unlink
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setPreviousReferralId((priors[0] as any).id ?? null)}
                >
                  Link to most recent
                </Button>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Status">
              <Select value={f.status} onValueChange={(v) => {
                const status = v as DraftForm["status"];
                setF((prev) => {
                  const next = { ...prev, status };
                  if ((status === "accepted" || status === "admitted") && !prev.decision_at) {
                    next.decision_at = localISO();
                  }
                  return next;
                });
              }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="accepted">Accepted</SelectItem>
                  <SelectItem value="admitted">Admitted</SelectItem>
                  <SelectItem value="declined">Declined</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Admission urgency">
              <Select
                value={f.admission_urgency || "none"}
                onValueChange={(v) =>
                  set("admission_urgency", v === "none" ? "" : (v as AdmissionUrgency))
                }
              >
                <SelectTrigger><SelectValue placeholder="Not specified" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not specified</SelectItem>
                  {ADMISSION_URGENCY_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          {f.status === "declined" && (
            <>
              <Field
                label="Reason for declining"
                required
                error={showErrors && declineReasonMissing ? "Required when declining a referral." : undefined}
              >
                <Textarea
                  rows={3}
                  value={f.decline_reason}
                  onChange={(e) => set("decline_reason", e.target.value)}
                  className={cn(showErrors && declineReasonMissing && "border-destructive focus-visible:ring-destructive")}
                />
              </Field>
              <Field
                label="Discussed with critical care consultant"
                required
                error={showErrors && declineConsultantMissing ? "Required when declining a referral." : undefined}
              >
                <div className={cn(showErrors && declineConsultantMissing && "rounded-md ring-1 ring-destructive")}>
                  <ComboboxAdd
                    value={f.discussed_with_consultant}
                    onChange={(v) => set("discussed_with_consultant", v)}
                    options={consultants}
                    placeholder="Select or add consultant…"
                  />
                </div>
              </Field>
            </>
          )}
          {(f.status === "admitted" || f.status === "accepted") && (
            <Field
              label="Accepting critical care consultant"
              required
              error={acceptingConsultantMissing ? "Required when a referral is accepted or admitted." : undefined}
            >
              <div className={cn(acceptingConsultantMissing && "rounded-md ring-1 ring-destructive")}>
                <ComboboxAdd
                  value={f.accepting_consultant}
                  onChange={(v) => set("accepting_consultant", v)}
                  options={consultants}
                  placeholder="Select or add consultant…"
                />
              </div>
            </Field>
          )}
        </Section>

        <Section title="Noteboard">
          <p className="text-sm text-muted-foreground">
            The team noteboard becomes available after you save this referral. Save the referral, then post notes for other clinicians to see — each note is tagged with your name and the time it was written.
          </p>
        </Section>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => navigate({ to: "/" })}>Cancel</Button>
          <Button type="submit" disabled={saving || acceptingConsultantMissing || declineConsultantMissing}>{saving ? "Saving…" : "Save referral"}</Button>
        </div>
      </form>

      <PriorReferralsDialog
        open={priorOpen}
        onOpenChange={setPriorOpen}
        hospitalNumber={f.hospital_number}
        priors={priors}
      />
    </div>
    </ClinicalAccessGate>
  );
}
