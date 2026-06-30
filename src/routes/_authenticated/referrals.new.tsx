import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useServerFn } from "@tanstack/react-start";
import { createReferral, findReferralsByHospitalNumber } from "@/lib/referrals.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { AlertCircle } from "lucide-react";
import { ComboboxAdd } from "@/components/combobox-add";
import { useReferralOptions } from "@/hooks/use-referral-options";
import { toast } from "sonner";
import { format } from "date-fns";
import { validateReferralTimings } from "@/lib/referral-validation";
import {
  ADMISSION_URGENCY_OPTIONS,
  type AdmissionUrgency,
} from "@/lib/admission-urgency";
import { cn } from "@/lib/utils";

type PriorReferral = {
  id: string;
  hospital_number: string | null;
  referral_received_at: string;
  status: string;
  referring_specialty: string | null;
  current_ward: string | null;
  current_bed: string | null;
  reason_for_referral: string | null;
  past_medical_history: string | null;
  baseline_function: string | null;
  age: number | null;
  sex: string | null;
  consultant_to_consultant_only: boolean | null;
};

export const Route = createFileRoute("/_authenticated/referrals/new")({
  head: () => ({ meta: [{ title: "New referral — SDH Critical Care" }] }),
  component: NewReferralPage,
});


function localISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

const DRAFT_KEY = "referral-draft-v1";

type DraftForm = {
  age: string;
  sex: "male" | "female" | "other" | "unknown";
  hospital_number: string;
  current_ward: string;
  current_bed: string;
  past_medical_history: string;
  baseline_function: string;
  dnacpr_respect: boolean;
  consultant_to_consultant_only: boolean;
  referring_specialty: string;
  reason_for_referral: string;
  referral_received_at: string;
  first_seen_at: string;
  decision_at: string;
  arrived_on_unit_at: string;
  status: "pending" | "accepted" | "declined" | "admitted";
  decline_reason: string;
  discussed_with_consultant: string;
  accepting_consultant: string;
  admission_urgency: AdmissionUrgency | "";
};

const blankForm = (): DraftForm => ({
  age: "",
  sex: "unknown",
  hospital_number: "",
  current_ward: "",
  current_bed: "",
  past_medical_history: "",
  baseline_function: "",
  dnacpr_respect: false,
  consultant_to_consultant_only: false,
  referring_specialty: "",
  reason_for_referral: "",
  referral_received_at: localISO(),
  first_seen_at: "",
  decision_at: "",
  arrived_on_unit_at: "",
  status: "pending",
  decline_reason: "",
  discussed_with_consultant: "",
  accepting_consultant: "",
  admission_urgency: "",
});

function isDraftDirty(d: DraftForm): boolean {
  const b = blankForm();
  // Ignore referral_received_at default (timestamp differs per render).
  const keys = (Object.keys(b) as (keyof DraftForm)[]).filter(
    (k) => k !== "referral_received_at",
  );
  return keys.some((k) => d[k] !== b[k]);
}

function NewReferralPage() {
  const navigate = useNavigate();
  const create = useServerFn(createReferral);
  const [saving, setSaving] = useState(false);
  const { specialties, wards, consultants } = useReferralOptions();
  const [f, setF] = useState<DraftForm>(blankForm);
  const [draftRestored, setDraftRestored] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState<Date | null>(null);

  // Restore any in-progress draft from localStorage on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<DraftForm>;
      const restored: DraftForm = { ...blankForm(), ...parsed };
      if (isDraftDirty(restored)) {
        setF(restored);
        setDraftRestored(true);
        toast.info("Restored your in-progress referral draft.");
      }
    } catch {
      // ignore corrupt draft
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-save the draft (debounced) whenever the form changes.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const t = setTimeout(() => {
      try {
        if (isDraftDirty(f)) {
          window.localStorage.setItem(DRAFT_KEY, JSON.stringify(f));
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

  // Warn before leaving with an unsaved draft on the page.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (e: BeforeUnloadEvent) => {
      if (isDraftDirty(f)) {
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

  // Auto-persist the C2C flag from any prior referral for this patient.
  useEffect(() => {
    if (priorC2C && !f.consultant_to_consultant_only) {
      setF((cur) => ({ ...cur, consultant_to_consultant_only: true }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priorC2C]);

  const showAlert =
    priors.length > 0 && dismissedFor !== f.hospital_number.trim();

  // Most-recent prior with usable PMH or baseline function for autofill.
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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!timing.isValid || declineReasonMissing || declineConsultantMissing || acceptingConsultantMissing) {
      setShowErrors(true);
      const msg = acceptingConsultantMissing && timing.isValid && !declineReasonMissing && !declineConsultantMissing
        ? "An accepting consultant is required when admitting a referral."
        : declineConsultantMissing && timing.isValid && !declineReasonMissing && !acceptingConsultantMissing
        ? "Please record which critical care consultant the referral was discussed with."
        : declineReasonMissing && timing.isValid && !acceptingConsultantMissing && !declineConsultantMissing
        ? "A reason is required when declining a referral."
        : "Please fix the highlighted fields before saving.";
      toast.error(msg);
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
    <div className="p-4 sm:p-6 max-w-3xl mx-auto">
      <div className="flex items-end justify-between mb-6 gap-4 flex-wrap">
        <h1 className="text-2xl font-semibold tracking-tight">New referral</h1>
        {(draftRestored || draftSavedAt) && isDraftDirty(f) && (
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
            <Field label="Referring specialty"><ComboboxAdd value={f.referring_specialty} onChange={(v) => set("referring_specialty", v)} options={specialties} placeholder="e.g. General Surgery" /></Field>
            <Field label="Current ward"><ComboboxAdd value={f.current_ward} onChange={(v) => set("current_ward", v)} options={wards} placeholder="e.g. ED Resus, Pembroke" /></Field>
            <Field label="Bed"><Input value={f.current_bed} onChange={(e) => set("current_bed", e.target.value)} /></Field>
          </div>
          {showAlert && (
            <Alert variant="destructive" className="mt-2">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Previous referral{priors.length > 1 ? "s" : ""} on record</AlertTitle>
              <AlertDescription className="flex flex-col gap-2">
                <span>
                  This patient (hospital number <strong>{f.hospital_number}</strong>) has been referred to critical care {priors.length} time{priors.length > 1 ? "s" : ""} before.
                </span>
                <div className="flex gap-2 flex-wrap">
                  <Button type="button" size="sm" variant="outline" onClick={() => setPriorOpen(true)}>
                    View previous referrals for this patient
                  </Button>
                  {priorWithHistory && (
                    <Button type="button" size="sm" variant="outline" onClick={autofillPMH}>
                      Auto-fill past medical history
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setDismissedFor(f.hospital_number.trim())}
                  >
                    Dismiss
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}
          {priorC2C && (
            <Alert variant="destructive" className="mt-2">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Consultant-to-consultant referral only</AlertTitle>
              <AlertDescription>
                A previous referral for this patient (hospital number{" "}
                <strong>{f.hospital_number}</strong>) was flagged as{" "}
                <strong>consultant-to-consultant only</strong>. This referral must
                be made consultant-to-consultant. The flag has been applied
                automatically below.
              </AlertDescription>
            </Alert>
          )}
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
              <AlertCircle className="h-4 w-4" />
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
        </Section>

        <Section title="Outcome">
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

      <Dialog open={priorOpen} onOpenChange={setPriorOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Previous referrals for {f.hospital_number || "this patient"}</DialogTitle>
            <DialogDescription>
              Click any referral to open the full form in a new tab.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto space-y-2">
            {priors.length === 0 && (
              <p className="text-sm text-muted-foreground py-6 text-center">No previous referrals.</p>
            )}
            {priors.map((p) => (
              <Link
                key={p.id}
                to="/referrals/$id"
                params={{ id: p.id }}
                target="_blank"
                rel="noopener noreferrer"
                className="block border rounded-md p-3 hover:bg-accent/40 transition-colors"
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="text-sm font-medium">
                    {format(new Date(p.referral_received_at), "dd MMM yyyy HH:mm")}
                  </div>
                  <Badge variant="outline" className="capitalize">{p.status}</Badge>
                </div>
                <div className="text-xs text-muted-foreground">
                  {p.referring_specialty ?? "Specialty unknown"}
                  {p.current_ward ? ` · ${p.current_ward}` : ""}
                  {p.current_bed ? ` ${p.current_bed}` : ""}
                </div>
                {p.reason_for_referral && (
                  <div className="text-sm mt-1 line-clamp-2">{p.reason_for_referral}</div>
                )}
              </Link>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPriorOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}


function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="p-5 space-y-4">
      <h2 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </Card>
  );
}
function Field({ label, children, required, error }: { label: string; children: React.ReactNode; required?: boolean; error?: string }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function DateTimeNow({ value, onChange, invalid }: { value: string; onChange: (v: string) => void; invalid?: boolean }) {
  return (
    <div className="flex gap-2">
      <Input
        type="datetime-local"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(!value && "text-muted-foreground", invalid && "border-destructive focus-visible:ring-destructive")}
      />
      <Button type="button" variant="outline" size="sm" onClick={() => onChange(localISO())}>Now</Button>
    </div>
  );
}
