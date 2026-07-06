import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { deleteReferral, getReferralDetail, logReferralView, updateReferral, type DecryptedReferral } from "@/lib/referrals.functions";
import { ReferralAuditTrail } from "@/components/referral-audit-trail";
import { PriorDeclinedReferrals } from "@/components/prior-declined-referrals";
import { Noteboard, referralNotesQueryOptions } from "@/components/noteboard";
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
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import type { Tables } from "@/integrations/supabase/types";
import { ComboboxAdd } from "@/components/combobox-add";
import { useReferralOptions } from "@/hooks/use-referral-options";
import { ArrowLeft, Save, Trash2, ChevronDown, AlertCircle } from "lucide-react";
import { format } from "date-fns";
import { tzTooltip } from "@/lib/format-timestamp";
import { toast } from "sonner";
import { validateReferralTimings } from "@/lib/referral-validation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ADMISSION_URGENCY_OPTIONS, type AdmissionUrgency } from "@/lib/admission-urgency";
import { cn } from "@/lib/utils";


type Referral = Tables<"referrals"> & DecryptedReferral;


// Queryable cache key for a single referral's decrypted detail. The loader
// primes this so navigation from the list page shows data on first paint;
// the component still owns local `ref` state for form edits (to avoid
// realtime refetches clobbering unsaved input), but seeds it from the cache.
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
  const [expandCmd, setExpandCmd] = useState<{ open: boolean; id: number } | null>(null);
  const { specialties, wards, consultants } = useReferralOptions();

  // Seed from the loader-primed cache so the initial paint has data. Local
  // state still owns edits (controlled form inputs) — realtime UPDATE calls
  // `loadRef` below to refresh the cache and the local state together.
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

    // Realtime for the referral row itself; notes/keys are handled inside
    // <Noteboard />.
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
    ref.status === "declined" && !((ref as any).discussed_with_consultant ?? "").trim();
  const acceptingConsultantMissing =
    (ref.status === "admitted" || ref.status === "accepted") && !((ref as any).accepting_consultant ?? "").trim();

  const save = async () => {
    if (!timing.isValid) {
      toast.error("Please fix the highlighted timing issues before saving.");
      return;
    }
    if (declineReasonMissing) {
      toast.error("A reason is required when declining a referral.");
      return;
    }
    if (declineConsultantMissing) {
      toast.error("Please record which critical care consultant the referral was discussed with.");
      return;
    }
    if (acceptingConsultantMissing) {
      toast.error("Please select the accepting critical care consultant before marking this referral as Accepted or Admitted.");
      return;
    }
    setSaving(true);
    try {
      const patch: any = {
        age: ref.age, sex: ref.sex, hospital_number: ref.hospital_number,
        current_ward: ref.current_ward, current_bed: ref.current_bed,
        past_medical_history: ref.past_medical_history, baseline_function: ref.baseline_function,
        dnacpr_respect: ref.dnacpr_respect, referring_specialty: ref.referring_specialty,
        consultant_to_consultant_only: (ref as any).consultant_to_consultant_only ?? false,
        reason_for_referral: ref.reason_for_referral, status: ref.status,
        decline_reason: ref.decline_reason,
        discussed_with_consultant: (ref as any).discussed_with_consultant ?? null,
        admission_urgency: ref.admission_urgency ?? null,
        accepting_consultant: (ref as any).accepting_consultant ?? null,
        referral_received_at: ref.referral_received_at,
        first_seen_at: ref.first_seen_at, decision_at: ref.decision_at,
        arrived_on_unit_at: ref.arrived_on_unit_at,
        is_test: (ref as any).is_test ?? false,
      };
      await update({ data: { id: ref.id, patch } });
      toast.success("Saved");
    } catch (err: any) {
      toast.error(err.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const encryptForRecipients = async (body: string, recipientIds: Set<string>) => {
    const dir = await fetchKeyDir({ data: undefined as any });
    const byId = new Map<string, string>();
    for (const r of (dir ?? []) as any[]) {
      if (r.public_key) byId.set(r.user_id, r.public_key as string);
    }
    // Ensure the author can decrypt their own note if selected.
    if (e2e.publicKey && user && !byId.has(user.id)) byId.set(user.id, e2e.publicKey);
    const recipients = Array.from(recipientIds)
      .filter((id) => byId.has(id))
      .map((id) => ({ user_id: id, public_key: byId.get(id)! }));
    if (!recipients.length) throw new Error("Pick at least one enrolled recipient before posting.");
    return e2eEncryptNote(body, recipients);
  };

  /**
   * Gate for referral encryption actions. If the recipient key isn't Ready
   * (unlocked in this tab), queue the action, prompt the user to unlock/enable
   * encryption, and return false. The queued action re-runs automatically
   * after a successful unlock via the E2EUnlockModal's onUnlocked callback,
   * so the user doesn't have to click Post/Save a second time.
   */
  const ensureUnlocked = (action: () => Promise<void>): boolean => {
    if (e2e.isUnlocked) return true;
    pendingActionRef.current = action;
    setUnlockOpen(true);
    toast.info(
      e2e.needsBootstrap
        ? "Enable end-to-end encryption to post this note."
        : "Unlock your recipient key to continue — we'll finish this action for you.",
    );
    return false;
  };


  const doPostNote = async () => {
    setPosting(true);
    try {
      const enc = await encryptForRecipients(noteBody.trim(), selectedRecipients);
      await submitEncNote({
        data: {
          referral_id: id,
          ...enc,
          // Server re-checks recipient coverage against the live key
          // directory. Only pass the opt-in flag when the author has
          // knowingly reduced the recipient set (touched the picker or
          // confirmed the reduced-set dialog).
          allow_reduced_recipients: recipientsTouched,
        },
      });
      setNoteBody("");
      await refetchNotes();
    } catch (err: any) {
      const msg = String(err?.message ?? "");
      const marker = "RECIPIENT_COVERAGE_CHANGED::";
      const idx = msg.indexOf(marker);
      if (idx >= 0) {
        // Structured coverage-change from the server. Parse the JSON payload,
        // refresh the local directory, and show a detailed toast so the
        // author knows exactly who to re-review.
        let payload: {
          missing_no_key: Array<{ user_id: string; full_name: string }>;
          enrolled_but_excluded: Array<{ user_id: string; full_name: string }>;
          stray_recipients: Array<{ user_id: string; full_name: string }>;
        } | null = null;
        try {
          payload = JSON.parse(msg.slice(idx + marker.length));
        } catch { /* fall through to generic toast */ }
        await loadDirectory();
        if (payload) {
          const fmt = (people: Array<{ full_name: string }>) =>
            people.length <= 3
              ? people.map((p) => p.full_name).join(", ")
              : `${people.slice(0, 3).map((p) => p.full_name).join(", ")} and ${people.length - 3} more`;
          const lines: string[] = [];
          if (payload.missing_no_key.length > 0) {
            lines.push(`Lost/never-published keys: ${fmt(payload.missing_no_key)}`);
          }
          if (payload.enrolled_but_excluded.length > 0) {
            lines.push(`Enrolled but not in recipients: ${fmt(payload.enrolled_but_excluded)}`);
          }
          if (payload.stray_recipients.length > 0) {
            lines.push(`Recipients with no current key: ${fmt(payload.stray_recipients)}`);
          }
          toast.error("Recipient list changed since you started composing", {
            description: lines.join(" · "),
            duration: 12000,
            action: {
              label: "Refresh recipients",
              onClick: () => { loadDirectory(); },
            },
          });
        } else {
          toast.error(
            "Recipient list changed since you started composing. Review recipients and try again.",
            { duration: 6000 },
          );
        }
      } else {
        const friendly = friendlyE2EError(err, "post-note");
        toast.error(friendly.title, { description: friendly.description, duration: 8000 });
      }
    } finally {
      setPosting(false);
    }
  };

  const postNote = async () => {
    if (!noteBody.trim()) return;
    if (!ensureUnlocked(postNote)) return;
    if (selectedRecipients.size === 0) {
      toast.error("Pick at least one recipient for this note.");
      return;
    }
    // Refresh directory just before posting so the check reflects reality.
    const list = await loadDirectory();
    const missing = (list ?? directory).filter(
      (r) => !r.public_key && r.user_id !== user?.id,
    );
    // Hard block: if any teammate is missing a public key and the author
    // has NOT explicitly changed the recipient set, force them to open the
    // picker and opt into a reduced set first.
    if (missing.length > 0 && !recipientsTouched) {
      pendingActionRef.current = doPostNote;
      setConfirmMissingOpen(true);
      return;
    }
    await doPostNote();
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
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between gap-2 mb-6 flex-wrap">
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: "/" })}><ArrowLeft className="w-4 h-4 mr-1" /> Back to list</Button>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={`capitalize ${statusStyles[ref.status]}`}>{ref.status}</Badge>
          {canDelete && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" className="text-destructive hover:text-destructive">
                  <Trash2 className="w-4 h-4 mr-1" /> Delete
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
            <F label="Age"><Input type="number" value={ref.age ?? ""} onChange={(e) => set("age", e.target.value ? Number(e.target.value) : null)} /></F>
            <F label="Sex">
              <Select value={ref.sex ?? "unknown"} onValueChange={(v) => set("sex", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["male","female","other","unknown"].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </F>
            <F label="Hospital number"><Input value={ref.hospital_number ?? ""} onChange={(e) => set("hospital_number", e.target.value)} /></F>
            <F label="Referring specialty"><ComboboxAdd value={ref.referring_specialty ?? ""} onChange={(v) => set("referring_specialty", v)} options={specialties} /></F>
            <F label="Ward"><ComboboxAdd value={ref.current_ward ?? ""} onChange={(v) => set("current_ward", v)} options={wards} /></F>
            <F label="Bed"><Input value={ref.current_bed ?? ""} onChange={(e) => set("current_bed", e.target.value)} /></F>
          </div>
          <ExpandableSection label="Past medical history" command={expandCmd}><Textarea rows={3} value={ref.past_medical_history ?? ""} onChange={(e) => set("past_medical_history", e.target.value)} /></ExpandableSection>
          <ExpandableSection label="Baseline function" command={expandCmd}><Textarea rows={2} value={ref.baseline_function ?? ""} onChange={(e) => set("baseline_function", e.target.value)} /></ExpandableSection>
          <ExpandableSection label="Reason for referral" command={expandCmd}><Textarea rows={3} value={ref.reason_for_referral ?? ""} onChange={(e) => set("reason_for_referral", e.target.value)} /></ExpandableSection>
          <div className="flex items-center gap-3">
            <Switch checked={ref.dnacpr_respect} onCheckedChange={(v) => set("dnacpr_respect", v)} id="dn" />
            <Label htmlFor="dn">DNACPR / ReSPECT in place</Label>
          </div>
          <div className="flex items-center gap-3">
            <Switch
              checked={(ref as any).consultant_to_consultant_only ?? false}
              onCheckedChange={(v) => set("consultant_to_consultant_only" as any, v as any)}
              id="c2c"
            />
            <Label htmlFor="c2c">Consultant-to-consultant referral only</Label>
          </div>
          <div className="flex items-start justify-between gap-4 rounded-md border border-amber-400/60 bg-amber-50/40 dark:bg-amber-950/20 p-3">
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
              checked={(ref as any).is_test ?? false}
              onCheckedChange={(v) => set("is_test" as any, v as any)}
            />
          </div>
        </Card>


        <PriorDeclinedReferrals hospitalNumber={ref.hospital_number} excludeId={id} />




        <Card className="p-5 space-y-4">
          <h2 className="font-semibold">Timeline (ICNARC)</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <F label="Received" required error={timing.fieldErrors.referral_received_at}>
              <DTNow value={toLocal(ref.referral_received_at)} onChange={(v) => saveTimestamp("referral_received_at", v ? new Date(v).toISOString() : null)} invalid={!!timing.fieldErrors.referral_received_at} />
            </F>
            <F label="First seen" required={ref.status !== "pending"} error={timing.fieldErrors.first_seen_at}>
              <DTNow value={toLocal(ref.first_seen_at)} onChange={(v) => saveTimestamp("first_seen_at", v ? new Date(v).toISOString() : null)} invalid={!!timing.fieldErrors.first_seen_at} />
            </F>
            <F label="Decision" required={ref.status !== "pending"} error={timing.fieldErrors.decision_at}>
              <DTNow value={toLocal(ref.decision_at)} onChange={(v) => saveTimestamp("decision_at", v ? new Date(v).toISOString() : null)} invalid={!!timing.fieldErrors.decision_at} />
            </F>
            <F label="Arrived on unit" required={ref.status === "admitted"} error={timing.fieldErrors.arrived_on_unit_at}>
              <DTNow value={toLocal(ref.arrived_on_unit_at)} onChange={(v) => saveTimestamp("arrived_on_unit_at", v ? new Date(v).toISOString() : null)} disabled={ref.status === "declined"} invalid={!!timing.fieldErrors.arrived_on_unit_at} />
            </F>
          </div>
          {timing.issues.length > 0 && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
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

        <Card ref={outcomeRef} className="p-5 space-y-4">
          <h2 className="font-semibold">Outcome</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <F label="Status">
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
            </F>
            <F label="Admission urgency">
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
            </F>
          </div>
          {ref.status === "declined" && (
            <>
              <ExpandableSection label="Reason for declining" command={expandCmd}>
                <Textarea
                  rows={3}
                  value={ref.decline_reason ?? ""}
                  onChange={(e) => set("decline_reason", e.target.value)}
                  className={declineReasonMissing ? "border-destructive focus-visible:ring-destructive" : undefined}
                />
                {declineReasonMissing && (
                  <p className="text-xs text-destructive mt-1">Required when declining a referral.</p>
                )}
              </ExpandableSection>
              <F label="Discussed with critical care consultant" required error={declineConsultantMissing ? "Required when declining a referral." : undefined}>
                <div className={cn(declineConsultantMissing && "rounded-md ring-1 ring-destructive")}>
                  <ComboboxAdd
                    value={(ref as any).discussed_with_consultant ?? ""}
                    onChange={(v) => set("discussed_with_consultant" as any, (v || null) as any)}
                    options={consultants}
                    placeholder="Select or add consultant…"
                  />
                </div>
              </F>
            </>
          )}
          {(ref.status === "admitted" || ref.status === "accepted") && (
            <F label="Accepting critical care consultant" required error={acceptingConsultantMissing ? "Required when a referral is accepted or admitted." : undefined}>
              <div className={cn(acceptingConsultantMissing && "rounded-md ring-1 ring-destructive")}>
                <ComboboxAdd
                  value={ref.accepting_consultant ?? ""}
                  onChange={(v) => set("accepting_consultant", v || null)}
                  options={consultants}
                  placeholder="Select or add consultant…"
                />
              </div>
            </F>
          )}
        </Card>

        <div className="flex justify-end">
          <Button onClick={save} disabled={saving || acceptingConsultantMissing || declineConsultantMissing}><Save className="w-4 h-4 mr-1" />{saving ? "Saving…" : "Save changes"}</Button>
        </div>

        <Card className="p-5">
          <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="font-semibold flex items-center gap-2">
                Noteboard
                {e2e.isUnlocked ? (
                  <Badge variant="outline" className="text-[10px] gap-1">
                    <LockOpen className="w-3 h-3" /> E2E unlocked
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px] gap-1">
                    <Lock className="w-3 h-3" /> E2E locked
                  </Badge>
                )}
              </h2>
              <Select value={noteFilter} onValueChange={(v) => setNoteFilter(v as typeof noteFilter)}>
                <SelectTrigger className="h-7 text-xs w-auto min-w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All notes ({notes.length})</SelectItem>
                  <SelectItem value="e2e">E2E encrypted ({notes.filter((n) => n._e2eStatus === "e2e-decrypted" || n._e2eStatus === "e2e-locked" || n._e2eStatus === "e2e-no-key" || n._e2eStatus === "e2e-failed").length})</SelectItem>
                  <SelectItem value="legacy">Legacy plaintext ({notes.filter((n) => n._e2eStatus === "legacy-server-enc" || n._e2eStatus === "plaintext").length})</SelectItem>
                  <SelectItem value="failed">Failed to decrypt ({notes.filter((n) => n._e2eStatus === "e2e-failed").length})</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {!e2e.isUnlocked && (
              <Button size="sm" variant="outline" onClick={() => setUnlockOpen(true)}>
                {e2e.needsBootstrap ? "Enable encryption" : "Unlock notes"}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            Messages are end-to-end encrypted in your browser — the server only stores ciphertext.
          </p>
          {e2e.isUnlocked && missingRecipients.length > 0 && (
            <Alert variant="destructive" className="mb-3">
              <ShieldAlert className="w-4 h-4" />
              <AlertTitle>
                {missingRecipients.length} teammate{missingRecipients.length === 1 ? "" : "s"} can't read encrypted notes yet
              </AlertTitle>
              <AlertDescription>
                <div className="mb-2">
                  They haven't enabled end-to-end encryption on their account, so anything you post now will be
                  <strong> undecryptable for them</strong> until they enroll and you re-post. Ask them to open the
                  noteboard and choose <em>Enable encryption</em>.
                </div>
                <ul className="list-disc pl-5 text-xs max-h-24 overflow-auto">
                  {missingRecipients.slice(0, 8).map((r) => (
                    <li key={r.user_id}>{r.full_name}</li>
                  ))}
                  {missingRecipients.length > 8 && <li>and {missingRecipients.length - 8} more…</li>}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          {e2e.isUnlocked && partialCoverage && (recipientsTouched || excludedDeselected.length > 0) && (
            <Alert className="mb-3 border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200 [&>svg]:text-amber-600">
              <ShieldAlert className="w-4 h-4" />
              <AlertTitle>
                Only {eligibleRecipientCount} of {eligibleRecipientCount + excludedMissingKey.length + excludedDeselected.length} teammates will be able to read this note
              </AlertTitle>
              <AlertDescription>
                <div className="mb-2 text-xs">
                  The people below <strong>will not</strong> be able to decrypt this note as composed.
                  Adjust recipients or ask them to enable encryption before posting.
                </div>
                {excludedDeselected.length > 0 && (
                  <div className="mb-2">
                    <div className="text-[11px] font-medium uppercase tracking-wide opacity-80">
                      Deselected ({excludedDeselected.length})
                    </div>
                    <ul className="list-disc pl-5 text-xs max-h-24 overflow-auto">
                      {excludedDeselected.slice(0, 8).map((r) => (
                        <li key={r.user_id}>{r.full_name}</li>
                      ))}
                      {excludedDeselected.length > 8 && <li>and {excludedDeselected.length - 8} more…</li>}
                    </ul>
                  </div>
                )}
                {excludedMissingKey.length > 0 && (
                  <div>
                    <div className="text-[11px] font-medium uppercase tracking-wide opacity-80">
                      No encryption key yet ({excludedMissingKey.length})
                    </div>
                    <ul className="list-disc pl-5 text-xs max-h-24 overflow-auto">
                      {excludedMissingKey.slice(0, 8).map((r) => (
                        <li key={r.user_id}>{r.full_name}</li>
                      ))}
                      {excludedMissingKey.length > 8 && <li>and {excludedMissingKey.length - 8} more…</li>}
                    </ul>
                  </div>
                )}
              </AlertDescription>
            </Alert>
          )}
          <div className="space-y-2 mb-4">
            {e2e.isUnlocked && directoryWithSelf.length > 0 && (
              <div className="flex flex-wrap gap-1.5 rounded-md border bg-muted/30 p-2">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground self-center mr-1">
                  Recipient keys
                </span>
                {[...directoryWithSelf]
                  .sort((a, b) => {
                    const na = newlyEligibleIds.has(a.user_id) ? 0 : 1;
                    const nb = newlyEligibleIds.has(b.user_id) ? 0 : 1;
                    if (na !== nb) return na - nb;
                    const ka = a.public_key ? 0 : 1;
                    const kb = b.public_key ? 0 : 1;
                    if (ka !== kb) return ka - kb;
                    return a.full_name.localeCompare(b.full_name);
                  })
                  .map((r) => {
                    const isMe = r.user_id === user?.id;
                    const hasKey = !!r.public_key;
                    const isSelected = selectedRecipients.has(r.user_id);
                    const isNew = newlyEligibleIds.has(r.user_id);
                    const status: "selected" | "deselected" | "blocked" = !hasKey
                      ? "blocked"
                      : isSelected
                        ? "selected"
                        : "deselected";
                    const styles = {
                      selected:
                        "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20",
                      deselected:
                        "border-border bg-background text-muted-foreground hover:bg-accent",
                      blocked:
                        "border-destructive/40 bg-destructive/10 text-destructive cursor-not-allowed",
                    }[status];
                    const Icon =
                      status === "blocked"
                        ? ShieldAlert
                        : status === "selected"
                          ? ShieldCheck
                          : ShieldOff;
                    const title =
                      status === "blocked"
                        ? `${r.full_name} — no published encryption key. Ask them to enable encryption on the noteboard.`
                        : status === "selected"
                          ? `${r.full_name} — will be able to decrypt this note.${isNew ? " Just enabled encryption." : ""}`
                          : `${r.full_name} — has a key but is not a recipient of this note. Click to include.`;
                    return (
                      <button
                        key={r.user_id}
                        type="button"
                        disabled={!hasKey}
                        onClick={() => {
                          if (!hasKey) return;
                          setRecipientsTouched(true);
                          const next = new Set(selectedRecipients);
                          if (next.has(r.user_id)) next.delete(r.user_id);
                          else next.add(r.user_id);
                          setSelectedRecipients(next);
                        }}
                        title={title}
                        className={cn(
                          "relative inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors",
                          styles,
                          isNew && "ring-2 ring-sky-400 ring-offset-1 ring-offset-background",
                        )}
                      >
                        <Icon className="w-3 h-3" />
                        <span className="max-w-[9rem] truncate">
                          {r.full_name}
                          {isMe && <span className="ml-1 opacity-70">(you)</span>}
                        </span>
                        {isNew && (
                          <span className="ml-1 rounded bg-sky-500/20 px-1 text-[9px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">
                            New
                          </span>
                        )}
                      </button>
                    );
                  })}
              </div>
            )}
            <Textarea rows={3} value={noteBody} onChange={(e) => setNoteBody(e.target.value)} placeholder="e.g. seen in ED resus, awaiting bloods, for re-review at 6pm" />
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-[11px] text-muted-foreground">
                {e2e.isUnlocked
                  ? `Will be readable by ${eligibleRecipientCount} teammate${eligibleRecipientCount === 1 ? "" : "s"}.`
                  : ""}
              </span>
              <div className="flex items-center gap-2">
                {e2e.isUnlocked && (
                  <NoteRecipientPicker
                    directory={directoryWithSelf}
                    selected={selectedRecipients}
                    onChange={(next) => { setRecipientsTouched(true); setSelectedRecipients(next); }}
                    currentUserId={user?.id}
                    compact
                  />
                )}
                <Button size="sm" onClick={postNote} disabled={posting || !noteBody.trim()}>
                  {posting ? "Posting…" : e2e.isUnlocked ? "Post encrypted note" : "Unlock & post"}
                </Button>
              </div>
            </div>
          </div>
          <div className="space-y-3 max-h-[520px] overflow-auto">
            {filteredNotes.length === 0 && (
              <p className="text-xs text-muted-foreground">
                {notes.length === 0 ? "No notes yet." : "No notes match the selected filter."}
              </p>
            )}
            {filteredNotes.map((n) => (
              <NoteItem
                key={n.id}
                note={n}
                authorName={authors[n.author_id] ?? "Clinician"}
                authorMap={authors}
                directory={directoryWithSelf}
                currentUserId={user?.id}
                canEdit={!!user && (user.id === n.author_id || isAdmin) && n._e2eStatus !== "e2e-locked" && n._e2eStatus !== "e2e-no-key" && n._e2eStatus !== "e2e-failed" && n._e2eStatus !== "legacy-server-enc" && n._e2eStatus !== "plaintext"}
                onSave={async (body, recipients) => {
                  if (n.body_ciphertext) {
                    const retry = () => (async () => {
                      // Re-run this exact edit (same body/recipients) after unlock.
                      const enc2 = await encryptForRecipients(body, recipients ?? new Set());
                      await editEncNote({ data: { id: n.id, ...enc2 } });
                      await refetchNotes();
                      toast.success("Note updated");
                    })();
                    if (!ensureUnlocked(() => retry())) return;
                    if (!recipients || recipients.size === 0) {
                      toast.error("Pick at least one recipient before saving.");
                      return;
                    }
                    const enc = await encryptForRecipients(body, recipients);
                    await editEncNote({ data: { id: n.id, ...enc } });
                    await refetchNotes();
                  } else {
                    await updateNoteFn({ data: { id: n.id, body } });
                    await refetchNotes();
                  }
                  toast.success("Note updated");
                }}
                onDelete={async () => {
                  await deleteNoteFn({ data: { id: n.id } });
                  await refetchNotes();
                  toast.success("Note deleted");
                }}
              />
            ))}
          </div>

        </Card>

        <E2EUnlockModal
          open={unlockOpen}
          onOpenChange={(o) => {
            setUnlockOpen(o);
            // Cancelling the unlock modal drops any queued encryption action
            // so a later confirm-missing-recipients flow can't accidentally
            // run it.
            if (!o && !e2e.isUnlocked) pendingActionRef.current = null;
          }}
          onUnlocked={async () => {
            await Promise.all([refetchNotes(), loadDirectory()]);
            // If an encryption action prompted the unlock, run it now so the
            // user doesn't have to click Post/Save a second time.
            const queued = pendingActionRef.current;
            if (queued) {
              pendingActionRef.current = null;
              try {
                await queued();
              } catch (err: any) {
                const friendly = friendlyE2EError(err, "post-note");
                toast.error(friendly.title, { description: friendly.description, duration: 8000 });
              }
            }
          }}
        />

        <AlertDialog
          open={confirmMissingOpen}
          onOpenChange={(o) => { setConfirmMissingOpen(o); if (!o) setAckReducedSet(false); }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-destructive" />
                Posting blocked — {missingRecipients.length} teammate{missingRecipients.length === 1 ? "" : "s"} can't read this note
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2 text-sm">
                  <div>
                    These teammates haven't enrolled in end-to-end encryption, so this note
                    <strong> cannot be encrypted for them</strong> — even later, after they enroll.
                  </div>
                  <ul className="list-disc pl-5 text-xs max-h-32 overflow-auto">
                    {missingRecipients.map((r) => (
                      <li key={r.user_id}>{r.full_name}</li>
                    ))}
                  </ul>
                  <div>
                    To continue, explicitly opt into posting to a reduced recipient set
                    ({eligibleRecipientCount} enrolled teammate{eligibleRecipientCount === 1 ? "" : "s"}).
                    Otherwise, cancel and ask them to enable encryption first.
                  </div>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <label className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm cursor-pointer">
              <Checkbox
                checked={ackReducedSet}
                onCheckedChange={(v) => setAckReducedSet(v === true)}
                className="mt-0.5"
              />
              <span>
                I understand the excluded teammates will never be able to read this note,
                and I want to post it to the reduced recipient set anyway.
              </span>
            </label>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => { pendingActionRef.current = null; setAckReducedSet(false); }}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={!ackReducedSet}
                onClick={async () => {
                  if (!ackReducedSet) return;
                  const fn = pendingActionRef.current;
                  pendingActionRef.current = null;
                  // Record the explicit opt-in so future posts don't re-prompt
                  // until the missing set changes.
                  setRecipientsTouched(true);
                  setConfirmMissingOpen(false);
                  setAckReducedSet(false);
                  if (fn) await fn();
                }}
              >
                Post to reduced recipient set
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>



        <ReferralAuditTrail referralId={id} />




        {canDelete && (
          <div className="flex justify-end pt-2">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm">
                  <Trash2 className="w-4 h-4 mr-1" /> Delete referral
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

function F({ label, children, required, error }: { label: string; children: React.ReactNode; required?: boolean; error?: string }) {
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

function ExpandableSection({ label, children, command }: { label: string; children: React.ReactNode; command?: { open: boolean; id: number } | null }) {
  const [open, setOpen] = useState(true);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => {
      setIsMobile(mq.matches);
      setOpen(!mq.matches);
    };
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (command) {
      setOpen(command.open);
    }
  }, [command?.id]);

  if (!isMobile) {
    return <F label={label}>{children}</F>;
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="space-y-1.5">
      <CollapsibleTrigger className="flex items-center justify-between w-full">
        <Label className="text-xs">{label}</Label>
        <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

function nowLocal() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function DTNow({ value, onChange, disabled, invalid }: { value: string; onChange: (v: string) => void; disabled?: boolean; invalid?: boolean }) {
  return (
    <div className={`flex gap-2 transition-opacity ${disabled ? "opacity-50" : ""}`}>
      <Input
        type="datetime-local"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={cn(
          disabled && "bg-muted border-muted-foreground/30",
          !value && "text-muted-foreground",
          invalid && !disabled && "border-destructive focus-visible:ring-destructive",
        )}
      />
      <Button type="button" variant="outline" size="sm" onClick={() => onChange(nowLocal())} disabled={disabled}>Now</Button>
    </div>
  );
}





