import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { deleteReferral, getReferralDetail, logReferralView, updateReferral, type DecryptedReferral } from "@/lib/referrals.functions";
import { ReferralAuditTrail } from "@/components/referral-audit-trail";
import { PriorDeclinedReferrals } from "@/components/prior-declined-referrals";
import { RouteErrorFallback } from "@/components/route-error-fallback";
import { ClinicalAccessGate } from "@/components/clinical-access-gate";
import { ReferralRouteError } from "@/components/referral-route-error";
import { Noteboard, referralNotesQueryOptions } from "@/components/noteboard";
import { TaskList } from "@/components/referrals/task-list";
import { MessageLog } from "@/components/referrals/message-log";
import { useAuth, useRole } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { Tables } from "@/integrations/supabase/types";
import { ComboboxAdd } from "@/components/combobox-add";
import { useReferralOptions } from "@/hooks/use-referral-options";
import { ArrowLeft, Save, Trash2, AlertCircle } from "lucide-react";
import { format } from "date-fns";
import { tzTooltip } from "@/lib/format-timestamp";
import { toast } from "sonner";
import { validateReferralAll, validateReferralTimings } from "@/lib/referral-validation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ADMISSION_URGENCY_OPTIONS, type AdmissionUrgency } from "@/lib/admission-urgency";
import { cn } from "@/lib/utils";
import { DateTimeNow, Field } from "@/components/referrals/referral-form-fields";
import {
  ReferralExpandableSection,
  type ExpandCommand,
} from "@/components/referrals/referral-expandable-section";
import { ClinicalFields, clinicalFieldsFromRow } from "@/components/referrals/clinical-fields";
import { OutcomeSelector } from "@/components/referrals/outcome-selector";
import { validateReferralOutcome, type ReferralOutcome } from "@/lib/referral-outcome";
import { AdmissionCapacityCallout } from "@/components/referrals/admission-capacity-callout";


type Referral = Tables<"referrals"> & DecryptedReferral;

const referralDetailQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ["referrals", "detail", id] as const,
    queryFn: () => getReferralDetail({ data: { id } }),
    staleTime: 5_000,
  });

export const Route = createFileRoute("/_authenticated/referrals/$id")({
  validateSearch: (search: Record<string, unknown>) => ({
    highlight: typeof search.highlight === "string" ? search.highlight : undefined,
  }),
  head: () => ({ meta: [{ title: "Referral — SDH Critical Care" }, { name: "robots", content: "noindex" }] }),
  loader: ({ context, params }) => {
    context.queryClient.ensureQueryData(referralNotesQueryOptions(params.id));
    return context.queryClient.ensureQueryData(referralDetailQueryOptions(params.id));
  },
  errorComponent: ({ error }) => <ReferralRouteError error={error} label="Referral" />,
  component: ReferralDetail,
});

function toLocal(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function ReferralDetail() {
  const { id } = Route.useParams();
  const { highlight } = Route.useSearch();
  const navigate = useNavigate();
  const update = useServerFn(updateReferral);
  const logView = useServerFn(logReferralView);
  const removeReferral = useServerFn(deleteReferral);
  const fetchDetail = useServerFn(getReferralDetail);
  const { user } = useAuth();
  const { hasRole: isAdmin } = useRole("admin");
  const [deleting, setDeleting] = useState(false);
  const [expandCmd, setExpandCmd] = useState<ExpandCommand>(null);
  const { specialties, wards, consultants } = useReferralOptions();

  const queryClient = useQueryClient();
  const [ref, setRef] = useState<Referral | null>(
    () => (queryClient.getQueryData(referralDetailQueryOptions(id).queryKey) as Referral | null) ?? null,
  );

  const [saving, setSaving] = useState(false);
  const outcomeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (highlight === "declined" && ref?.status === "declined" && outcomeRef.current) {
      outcomeRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
      outcomeRef.current.classList.add("ring-2", "ring-destructive", "ring-offset-2", "rounded-xl");
      const timer = setTimeout(() => {
        outcomeRef.current?.classList.remove("ring-2", "ring-destructive", "ring-offset-2", "rounded-xl");
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [highlight, ref?.status]);

  const loadRef = async () => {
    try {
      const r = await fetchDetail({ data: { id } });
      setRef(r as Referral | null);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to load referral");
    }
  };

  useEffect(() => {
    logView({ data: { referral_id: id } }).catch(() => {});
    loadRef();

    const ch = supabase
      .channel(`ref-${id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "referrals", filter: `id=eq.${id}` },
        () => { loadRef(); })
      .subscribe();

    return () => {
      supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!ref) return <div className="p-6 text-muted-foreground">Loading…</div>;

  const canDelete = !!user && (user.id === ref.created_by || isAdmin);

  const set = (k: keyof Referral, v: any) => setRef({ ...ref, [k]: v });

  const timing = validateReferralTimings({
    status: ref.status,
    referral_received_at: ref.referral_received_at,
    first_seen_at: ref.first_seen_at,
    decision_at: ref.decision_at,
    arrived_on_unit_at: ref.arrived_on_unit_at,
  });

  const declineReasonMissing =
    ref.status === "declined" && !(ref.decline_reason ?? "").trim();
  const declineConsultantMissing =
    ref.status === "declined" && !(ref.discussed_with_consultant ?? "").trim();
  const acceptingConsultantMissing =
    (ref.status === "admitted" || ref.status === "accepted") && !(ref.accepting_consultant ?? "").trim();

  const save = async () => {
    const combined = validateReferralAll({
      status: ref.status,
      referral_received_at: ref.referral_received_at,
      first_seen_at: ref.first_seen_at,
      decision_at: ref.decision_at,
      arrived_on_unit_at: ref.arrived_on_unit_at,
      decline_reason: ref.decline_reason,
      discussed_with_consultant: ref.discussed_with_consultant,
      accepting_consultant: ref.accepting_consultant,
      admission_urgency: ref.admission_urgency,
    });
    if (!combined.isValid) {
      const firstFieldError = Object.values(combined.fieldErrors)[0];
      toast.error(firstFieldError ?? combined.issues[0] ?? "Please fix the highlighted fields before saving.");
      return;
    }

    setSaving(true);
    try {
      const patch: any = {
        age: ref.age, sex: ref.sex, hospital_number: ref.hospital_number,
        current_ward: ref.current_ward, current_bed: ref.current_bed,
        past_medical_history: ref.past_medical_history, baseline_function: ref.baseline_function,
        dnacpr_respect: ref.dnacpr_respect, referring_specialty: ref.referring_specialty,
        consultant_to_consultant_only: ref.consultant_to_consultant_only ?? false,
        reason_for_referral: ref.reason_for_referral, status: ref.status,
        decline_reason: ref.decline_reason,
        discussed_with_consultant: ref.discussed_with_consultant ?? null,
        admission_urgency: ref.admission_urgency ?? null,
        accepting_consultant: ref.accepting_consultant ?? null,
        referral_received_at: ref.referral_received_at,
        first_seen_at: ref.first_seen_at, decision_at: ref.decision_at,
        arrived_on_unit_at: ref.arrived_on_unit_at,
        is_test: ref.is_test ?? false,
        // Point-2 clinical fields
        news2_score: (ref as any).news2_score ?? null,
        ceiling_of_care: (ref as any).ceiling_of_care ?? null,
        reason_category: (ref as any).reason_category ?? null,
        frailty_score: (ref as any).frailty_score ?? null,
        anticipated_interventions: (ref as any).anticipated_interventions ?? [],
        infection_status: (ref as any).infection_status ?? null,
        infection_organism: (ref as any).infection_organism ?? null,
        weight_kg: (ref as any).weight_kg == null ? null : Number((ref as any).weight_kg),
        allergies: (ref as any).allergies ?? null,
        resus_status: (ref as any).resus_status ?? null,
        needs_ward_review: (ref as any).needs_ward_review ?? false,
        for_ongoing_ccot_review: (ref as any).for_ongoing_ccot_review ?? false,
        ward_review_timeframe: (ref as any).ward_review_timeframe ?? null,
        outcome: (ref as any).outcome ?? null,
      };
      await update({ data: { id: ref.id, patch } });
      toast.success("Saved");

    } catch (err: any) {
      toast.error(err.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async () => {
    setDeleting(true);
    try {
      await removeReferral({ data: { id } });
      toast.success("Referral deleted");
      navigate({ to: "/" });
    } catch (err: any) {
      toast.error(err.message ?? "Delete failed");
      setDeleting(false);
    }
  };

  const saveTimestamp = async (key: keyof Referral, iso: string | null) => {
    setRef({ ...ref, [key]: iso } as Referral);
    try {
      await update({ data: { id, patch: { [key]: iso } } });
      toast.success("Saved", { duration: 1200 });
    } catch (err: any) {
      toast.error(err.message ?? "Auto-save failed");
    }
  };

  const statusStyles: Record<string, string> = {
    pending: "bg-warning/15 text-warning-foreground border-warning/30",
    admitted: "bg-success/15 text-success border-success/30",
    declined: "bg-destructive/10 text-destructive border-destructive/30",
  };

  return (
    <ClinicalAccessGate>
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between gap-2 mb-6 flex-wrap">
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: "/" })}>
          <ArrowLeft className="w-4 h-4 mr-1" aria-hidden="true" /> Back to list
        </Button>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={`capitalize ${statusStyles[ref.status]}`}>{ref.status}</Badge>
          {canDelete && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" className="text-destructive hover:text-destructive">
                  <Trash2 className="w-4 h-4 mr-1" aria-hidden="true" /> Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this referral?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently removes the referral and its notes. The deletion is recorded in the audit log. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={onDelete} disabled={deleting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                    {deleting ? "Deleting…" : "Delete referral"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      <h1 className="text-2xl font-semibold mb-1">
        {ref.hospital_number ?? "Referral"} · {ref.age ?? "?"}/{ref.sex ?? "?"}
      </h1>
      <p className="text-sm text-muted-foreground mb-2" title={tzTooltip(ref.referral_received_at)}>
        Received {format(new Date(ref.referral_received_at), "dd/MM/yyyy HH:mm:ss")}
      </p>
      <div className="flex gap-2 mb-4 md:hidden">
        <Button
          size="sm"
          variant="outline"
          className="flex-1"
          onClick={() => setExpandCmd({ open: true, id: Date.now() })}
        >
          Expand all
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="flex-1"
          onClick={() => setExpandCmd({ open: false, id: Date.now() })}
        >
          Collapse all
        </Button>
      </div>

      <div className="space-y-4">
        <Card className="p-5 space-y-4">
          <h2 className="font-semibold">Details</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Age"><Input type="number" value={ref.age ?? ""} onChange={(e) => set("age", e.target.value ? Number(e.target.value) : null)} /></Field>
            <Field label="Sex">
              <Select value={ref.sex ?? "unknown"} onValueChange={(v) => set("sex", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["male","female","other","unknown"].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Hospital number"><Input value={ref.hospital_number ?? ""} onChange={(e) => set("hospital_number", e.target.value)} /></Field>
            <Field label="Referring specialty"><ComboboxAdd value={ref.referring_specialty ?? ""} onChange={(v) => set("referring_specialty", v)} options={specialties} /></Field>
            <Field label="Ward"><ComboboxAdd value={ref.current_ward ?? ""} onChange={(v) => set("current_ward", v)} options={wards} /></Field>
            <Field label="Bed"><Input value={ref.current_bed ?? ""} onChange={(e) => set("current_bed", e.target.value)} /></Field>
          </div>
          <ReferralExpandableSection label="Past medical history" command={expandCmd}><Textarea rows={3} value={ref.past_medical_history ?? ""} onChange={(e) => set("past_medical_history", e.target.value)} /></ReferralExpandableSection>
          <ReferralExpandableSection label="Baseline function" command={expandCmd}><Textarea rows={2} value={ref.baseline_function ?? ""} onChange={(e) => set("baseline_function", e.target.value)} /></ReferralExpandableSection>
          <ReferralExpandableSection label="Reason for referral" command={expandCmd}><Textarea rows={3} value={ref.reason_for_referral ?? ""} onChange={(e) => set("reason_for_referral", e.target.value)} /></ReferralExpandableSection>
          <div className="flex items-center gap-3">
            <Switch checked={ref.dnacpr_respect} onCheckedChange={(v) => set("dnacpr_respect", v)} id="dn" />
            <Label htmlFor="dn">DNACPR / ReSPECT in place</Label>
          </div>
          <div className="flex items-center gap-3">
            <Switch
              checked={ref.consultant_to_consultant_only ?? false}
              onCheckedChange={(v) => set("consultant_to_consultant_only", v)}
              id="c2c"
            />
            <Label htmlFor="c2c">Consultant-to-consultant referral only</Label>
          </div>
          <div className="flex items-start justify-between gap-4 rounded-md border border-warning/60 bg-warning/10 p-3">
            <div>
              <Label htmlFor="is-test" className="text-sm font-medium cursor-pointer">
                Test / demonstration referral
              </Label>
              <p className="text-xs text-muted-foreground">
                Not a real patient. Test referrals show a badge on the list and
                are excluded from analytics.
              </p>
            </div>
            <Switch
              id="is-test"
              checked={ref.is_test ?? false}
              onCheckedChange={(v) => set("is_test", v)}
            />
          </div>
        </Card>

        <PriorDeclinedReferrals hospitalNumber={ref.hospital_number} excludeId={id} />

        <Card className="p-5 space-y-4">
          <h2 className="font-semibold">Timeline (ICNARC)</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Received" required error={timing.fieldErrors.referral_received_at}>
              <DateTimeNow value={toLocal(ref.referral_received_at)} onChange={(v) => saveTimestamp("referral_received_at", v ? new Date(v).toISOString() : null)} invalid={!!timing.fieldErrors.referral_received_at} />
            </Field>
            <Field label="First seen" required={ref.status !== "pending"} error={timing.fieldErrors.first_seen_at}>
              <DateTimeNow value={toLocal(ref.first_seen_at)} onChange={(v) => saveTimestamp("first_seen_at", v ? new Date(v).toISOString() : null)} invalid={!!timing.fieldErrors.first_seen_at} />
            </Field>
            <Field label="Decision" required={ref.status !== "pending"} error={timing.fieldErrors.decision_at}>
              <DateTimeNow value={toLocal(ref.decision_at)} onChange={(v) => saveTimestamp("decision_at", v ? new Date(v).toISOString() : null)} invalid={!!timing.fieldErrors.decision_at} />
            </Field>
            <Field label="Arrived on unit" required={ref.status === "admitted"} error={timing.fieldErrors.arrived_on_unit_at}>
              <DateTimeNow value={toLocal(ref.arrived_on_unit_at)} onChange={(v) => saveTimestamp("arrived_on_unit_at", v ? new Date(v).toISOString() : null)} disabled={ref.status === "declined"} invalid={!!timing.fieldErrors.arrived_on_unit_at} />
            </Field>
          </div>
          {timing.issues.length > 0 && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              <AlertTitle>Inconsistent timings</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4 space-y-1">
                  {timing.issues.map((m) => <li key={m}>{m}</li>)}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          <p className="text-xs text-muted-foreground">Timestamps save automatically. Fields marked <span className="text-destructive">*</span> are required for the ICNARC dataset.</p>
        </Card>

        <Card className="p-5 space-y-4">
          <h2 className="font-semibold">Clinical assessment</h2>
          <ClinicalFields
            value={clinicalFieldsFromRow(ref)}
            onChange={(patch) =>
              setRef({ ...ref, ...(patch as any) } as Referral)
            }
            age={ref.age ?? null}
          />
          <div className="pt-2 border-t">
            <OutcomeSelector
              value={((ref as any).outcome as ReferralOutcome | null) ?? null}
              onChange={(v) => setRef({ ...ref, outcome: v } as any)}
            />
          </div>
        </Card>

        <Card ref={outcomeRef} className="p-5 space-y-4">
          <h2 className="font-semibold">Outcome</h2>
          <AdmissionCapacityCallout />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Status">
              <Select value={ref.status} onValueChange={(v) => {
                const next: Partial<Referral> = { status: v as Referral["status"] };
                if ((v === "accepted" || v === "admitted") && !ref.decision_at) {
                  next.decision_at = new Date().toISOString();
                }
                setRef({ ...ref, ...next });
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
                value={ref.admission_urgency ?? "none"}
                onValueChange={(v) =>
                  set("admission_urgency", v === "none" ? null : (v as AdmissionUrgency))
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
          {ref.status === "declined" && (
            <>
              <ReferralExpandableSection label="Reason for declining" command={expandCmd}>
                <Textarea
                  rows={3}
                  value={ref.decline_reason ?? ""}
                  onChange={(e) => set("decline_reason", e.target.value)}
                  className={declineReasonMissing ? "border-destructive focus-visible:ring-destructive" : undefined}
                />
                {declineReasonMissing && (
                  <p className="text-xs text-destructive mt-1">Required when declining a referral.</p>
                )}
              </ReferralExpandableSection>
              <Field label="Discussed with critical care consultant" required error={declineConsultantMissing ? "Required when declining a referral." : undefined}>
                <div className={cn(declineConsultantMissing && "rounded-md ring-1 ring-destructive")}>
                  <ComboboxAdd
                    value={ref.discussed_with_consultant ?? ""}
                    onChange={(v) => set("discussed_with_consultant", v || null)}
                    options={consultants}
                    placeholder="Select or add consultant…"
                  />
                </div>
              </Field>
            </>
          )}
          {(ref.status === "admitted" || ref.status === "accepted") && (
            <Field label="Accepting critical care consultant" required error={acceptingConsultantMissing ? "Required when a referral is accepted or admitted." : undefined}>
              <div className={cn(acceptingConsultantMissing && "rounded-md ring-1 ring-destructive")}>
                <ComboboxAdd
                  value={ref.accepting_consultant ?? ""}
                  onChange={(v) => set("accepting_consultant", v || null)}
                  options={consultants}
                  placeholder="Select or add consultant…"
                />
              </div>
            </Field>
          )}
        </Card>

        <div className="flex flex-wrap gap-2 justify-end">
          {(ref.status === "accepted" || ref.status === "admitted") && (
            <Button
              variant="outline"
              onClick={() =>
                navigate({
                  to: "/bed-board",
                  search: {
                    source_referral_id: id,
                    hospital_number: ref.hospital_number ?? undefined,
                    patient_initials: undefined,
                    admitting_consultant: ref.accepting_consultant ?? undefined,
                    level: undefined,
                    source_label: `referral ${ref.hospital_number ?? ""}`.trim(),
                    source_postop_booking_id: undefined,
                  },
                })
              }
            >
              Admit to bed…
            </Button>
          )}
          <Button onClick={save} disabled={saving || acceptingConsultantMissing || declineConsultantMissing}>
            <Save className="w-4 h-4 mr-1" aria-hidden="true" />{saving ? "Saving…" : "Save changes"}
          </Button>
        </div>


        <Noteboard referralId={id} />

        <TaskList referralId={id} />

        <MessageLog referralId={id} />

        <ReferralAuditTrail referralId={id} />

        {canDelete && (
          <div className="flex justify-end pt-2">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm">
                  <Trash2 className="w-4 h-4 mr-1" aria-hidden="true" /> Delete referral
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Are you sure?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete the referral and all its notes. This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={deleting}>No, cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={onDelete} disabled={deleting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                    {deleting ? "Deleting…" : "Yes, delete referral"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
      </div>
    </div>
  );
}
