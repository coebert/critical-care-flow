import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { addNote, deleteNote, deleteReferral, findReferralsByHospitalNumber, getNoteHistory, getReferralDetail, getReferralHistory, logReferralView, updateNote, updateReferral, type ReferralAuditEntry, type DecryptedReferral, type DecryptedReferralNote } from "@/lib/referrals.functions";
import { addEncryptedNote, listEncryptedNotes, updateEncryptedNote } from "@/lib/encrypted-notes.functions";
import { getMyPrivateKeyMaterial, getPublicKeyDirectory } from "@/lib/e2e-keys.functions";
import { decryptNote as e2eDecryptNote, encryptNote as e2eEncryptNote } from "@/lib/e2e-crypto";
import { useE2ESession } from "@/hooks/use-e2e-session";
import { E2EUnlockModal } from "@/components/e2e-unlock-modal";
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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import type { Tables } from "@/integrations/supabase/types";
import { ComboboxAdd } from "@/components/combobox-add";
import { useReferralOptions } from "@/hooks/use-referral-options";
import { ArrowLeft, History, Pencil, Save, Trash2, X, ChevronDown, AlertCircle, Lock, LockOpen, ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { validateReferralTimings } from "@/lib/referral-validation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ADMISSION_URGENCY_OPTIONS, type AdmissionUrgency } from "@/lib/admission-urgency";
import { cn } from "@/lib/utils";


type Referral = Tables<"referrals"> & DecryptedReferral;
type Note = Tables<"referral_notes"> & DecryptedReferralNote & {
  wrapped_key?: string | null;
  body_ciphertext?: string | null;
  body_nonce?: string | null;
  enc_version?: number | null;
  _e2eStatus?: "plaintext" | "legacy-server-enc" | "e2e-decrypted" | "e2e-locked" | "e2e-no-key" | "e2e-failed";
};

export const Route = createFileRoute("/_authenticated/referrals/$id")({
  validateSearch: (search: Record<string, unknown>) => ({
    highlight: typeof search.highlight === "string" ? search.highlight : undefined,
  }),
  head: () => ({ meta: [{ title: "Referral — SDH Critical Care" }, { name: "robots", content: "noindex" }] }),
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
  const addNoteFn = useServerFn(addNote);
  const updateNoteFn = useServerFn(updateNote);
  const deleteNoteFn = useServerFn(deleteNote);
  const logView = useServerFn(logReferralView);
  const removeReferral = useServerFn(deleteReferral);
  const fetchHistory = useServerFn(getReferralHistory);
  const [history, setHistory] = useState<ReferralAuditEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const HISTORY_PAGE_SIZE = 20;

  const loadMoreHistory = async (reset = false) => {
    if (historyLoading) return;
    if (!reset && !historyHasMore) return;
    setHistoryLoading(true);
    try {
      const currentOffset = reset ? 0 : history.length;
      const page = await fetchHistory({
        data: { referral_id: id, offset: currentOffset, limit: HISTORY_PAGE_SIZE },
      });
      setHistory((cur) => (reset ? page.entries : [...cur, ...page.entries]));
      setHistoryTotal(page.total);
      setHistoryHasMore(page.hasMore);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to load history");
    } finally {
      setHistoryLoading(false);
    }
  };
  const historySentinelRef = useRef<HTMLDivElement>(null);
  const { user } = useAuth();
  const { hasRole: isAdmin } = useRole("admin");
  const [deleting, setDeleting] = useState(false);
  const [expandCmd, setExpandCmd] = useState<{ open: boolean; id: number } | null>(null);
  const { specialties, wards, consultants } = useReferralOptions();


  const [ref, setRef] = useState<Referral | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [authors, setAuthors] = useState<Record<string, string>>({});
  const [noteBody, setNoteBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [posting, setPosting] = useState(false);
  const [priorDeclined, setPriorDeclined] = useState<Referral[]>([]);
  const outcomeRef = useRef<HTMLDivElement>(null);

  // Auto-load the next page of audit history when the sentinel scrolls into view.
  useEffect(() => {
    if (!historyOpen || !historyHasMore) return;
    const node = historySentinelRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreHistory(false);
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyOpen, historyHasMore, history.length]);


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

  const upsertAuthorName = async (uid: string) => {
    if (authors[uid]) return;
    const { data } = await supabase.from("profiles").select("id,full_name").eq("id", uid).maybeSingle();
    if (data) setAuthors((cur) => ({ ...cur, [data.id]: data.full_name ?? "Clinician" }));
  };

  const fetchDetail = useServerFn(getReferralDetail);
  const fetchNotes = useServerFn(listEncryptedNotes);
  const fetchPriors = useServerFn(findReferralsByHospitalNumber);
  const fetchKeyMaterial = useServerFn(getMyPrivateKeyMaterial);
  const fetchKeyDir = useServerFn(getPublicKeyDirectory);
  const submitEncNote = useServerFn(addEncryptedNote);
  const editEncNote = useServerFn(updateEncryptedNote);

  const e2e = useE2ESession();
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [directory, setDirectory] = useState<Array<{ user_id: string; full_name: string; public_key: string | null }>>([]);
  const [confirmMissingOpen, setConfirmMissingOpen] = useState(false);
  const pendingActionRef = useRef<null | (() => Promise<void>)>(null);

  const loadDirectory = async () => {
    try {
      const d = (await fetchKeyDir({ data: undefined as any })) as any[];
      const list = (d ?? []) as Array<{ user_id: string; full_name: string; public_key: string | null }>;
      setDirectory(list);
      return list;
    } catch { return null; }
  };
  useEffect(() => { if (user) loadDirectory(); /* eslint-disable-next-line */ }, [user?.id, e2e.isUnlocked]);

  const missingRecipients = directory.filter((r) => !r.public_key && r.user_id !== user?.id);
  const eligibleRecipientCount =
    directory.filter((r) => !!r.public_key).length +
    (e2e.publicKey && !directory.some((r) => r.user_id === user?.id && !!r.public_key) ? 1 : 0);

  const loadRef = async () => {
    try {
      const r = await fetchDetail({ data: { id } });
      setRef(r as Referral | null);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to load referral");
    }
  };

  // Bootstrap E2E session: load stored key material once per session.
  useEffect(() => {
    if (!user) return;
    if (e2e.material || e2e.needsBootstrap) return;
    fetchKeyMaterial({ data: undefined as any })
      .then((res: any) => {
        e2e.setMaterial(res?.material ?? null, res?.public_key ?? null);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const decryptNoteRow = async (n: any): Promise<Note> => {
    if (n.body_ciphertext && n.body_nonce) {
      if (!n.wrapped_key) return { ...n, body: null, _e2eStatus: "e2e-no-key" };
      if (!e2e.isUnlocked || !e2e.privateKey || !e2e.publicKey) {
        return { ...n, body: null, _e2eStatus: "e2e-locked" };
      }
      try {
        const body = await e2eDecryptNote(
          { body_ciphertext: n.body_ciphertext, body_nonce: n.body_nonce, wrapped_key: n.wrapped_key },
          { publicKey: e2e.publicKey, privateKey: e2e.privateKey },
        );
        return { ...n, body, _e2eStatus: "e2e-decrypted" };
      } catch {
        return { ...n, body: null, _e2eStatus: "e2e-failed" };
      }
    }
    if (n.body_enc) return { ...n, _e2eStatus: "legacy-server-enc" };
    return { ...n, _e2eStatus: "plaintext" };
  };

  const loadNotes = async () => {
    try {
      const data = await fetchNotes({ data: { referral_id: id } });
      const sorted = [...(data ?? [])].sort(
        (a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
      const decrypted = await Promise.all(sorted.map((n) => decryptNoteRow(n)));
      setNotes(decrypted);
      const ids = Array.from(new Set(sorted.map((n: any) => n.author_id)));
      if (ids.length) {
        const { data: ps } = await supabase
          .from("profiles")
          .select("id,full_name")
          .in("id", ids as string[]);
        const map: Record<string, string> = {};
        ps?.forEach((p) => { map[p.id] = p.full_name ?? "Clinician"; });
        setAuthors(map);
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to load notes");
    }
  };

  useEffect(() => {
    logView({ data: { referral_id: id } }).catch(() => {});
    loadRef();
    loadNotes();

    // Realtime payloads contain ciphertext, so we use them only as a
    // signal to refetch via the decrypting server fn.
    const ch = supabase
      .channel(`ref-${id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "referrals", filter: `id=eq.${id}` },
        () => { loadRef(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "referral_notes", filter: `referral_id=eq.${id}` },
        () => { loadNotes(); })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Fetch other declined referrals for the same patient.
  useEffect(() => {
    const hn = ref?.hospital_number?.trim();
    if (!hn) {
      setPriorDeclined([]);
      return;
    }
    let cancelled = false;
    fetchPriors({ data: { hospital_number: hn, exclude_id: id } })
      .then((rows: any[]) => {
        if (cancelled) return;
        setPriorDeclined(((rows ?? []) as Referral[]).filter((r) => r.status === "declined"));
      })
      .catch(() => { if (!cancelled) setPriorDeclined([]); });
    return () => { cancelled = true; };
  }, [ref?.hospital_number, id, fetchPriors]);



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
      };
      await update({ data: { id: ref.id, patch } });
      toast.success("Saved");
    } catch (err: any) {
      toast.error(err.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const encryptForRecipients = async (body: string) => {
    const dir = await fetchKeyDir({ data: undefined as any });
    const recipients = (dir ?? [])
      .filter((r: any) => !!r.public_key)
      .map((r: any) => ({ user_id: r.user_id, public_key: r.public_key as string }));
    // Ensure the author can decrypt their own note too.
    if (e2e.publicKey && user && !recipients.some((r) => r.user_id === user.id)) {
      recipients.push({ user_id: user.id, public_key: e2e.publicKey });
    }
    if (!recipients.length) throw new Error("No teammates have enabled end-to-end encryption yet.");
    return e2eEncryptNote(body, recipients);
  };

  const doPostNote = async () => {
    setPosting(true);
    try {
      const enc = await encryptForRecipients(noteBody.trim());
      await submitEncNote({ data: { referral_id: id, ...enc } });
      setNoteBody("");
    } catch (err: any) {
      toast.error(err.message ?? "Failed to post note");
    } finally {
      setPosting(false);
    }
  };

  const postNote = async () => {
    if (!noteBody.trim()) return;
    if (!e2e.isUnlocked) { setUnlockOpen(true); return; }
    // Refresh directory just before posting so the warning reflects reality.
    const list = await loadDirectory();
    const missing = (list ?? directory).filter((r) => !r.public_key && r.user_id !== user?.id);
    if (missing.length > 0) {
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
      <p className="text-sm text-muted-foreground mb-2">
        Received {format(new Date(ref.referral_received_at), "PPpp")}
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
        </Card>

        {priorDeclined.length > 0 && (
          <Card className="p-5 space-y-3 border-destructive/40">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-destructive" />
              <h2 className="font-semibold text-destructive">
                Previously declined critical care referral{priorDeclined.length > 1 ? "s" : ""} for this patient
              </h2>
            </div>
            <p className="text-xs text-muted-foreground">
              Same hospital number ({ref.hospital_number}). Full decline reasons shown below.
            </p>
            <div className="space-y-3">
              {priorDeclined.map((p) => {
                const when = p.decision_at ?? p.referral_received_at;
                return (
                  <div key={p.id} className="border rounded-md p-3 bg-destructive/5">
                    <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                      <div className="text-sm font-medium">
                        Declined {when ? format(new Date(when), "PPp") : "date unknown"}
                        {p.referring_specialty ? ` · ${p.referring_specialty}` : ""}
                      </div>
                      <Link
                        to="/referrals/$id"
                        params={{ id: p.id }}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs underline text-muted-foreground hover:text-foreground"
                      >
                        Open full referral
                      </Link>
                    </div>
                    <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                      Reason for declining
                    </div>
                    {p.decline_reason ? (
                      <p className="text-sm whitespace-pre-wrap">{p.decline_reason}</p>
                    ) : (
                      <p className="text-sm italic text-muted-foreground">No reason recorded.</p>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        )}



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
          <div className="flex items-center justify-between gap-2 mb-1">
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
            {!e2e.isUnlocked && (
              <Button size="sm" variant="outline" onClick={() => setUnlockOpen(true)}>
                {e2e.needsBootstrap ? "Enable encryption" : "Unlock notes"}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            Messages are end-to-end encrypted in your browser — the server only stores ciphertext.
          </p>
          <div className="space-y-2 mb-4">
            <Textarea rows={3} value={noteBody} onChange={(e) => setNoteBody(e.target.value)} placeholder="e.g. seen in ED resus, awaiting bloods, for re-review at 6pm" />
            <div className="flex justify-end">
              <Button size="sm" onClick={postNote} disabled={posting || !noteBody.trim()}>
                {posting ? "Posting…" : e2e.isUnlocked ? "Post encrypted note" : "Unlock & post"}
              </Button>
            </div>
          </div>
          <div className="space-y-3 max-h-[520px] overflow-auto">
            {notes.length === 0 && <p className="text-xs text-muted-foreground">No notes yet.</p>}
            {notes.map((n) => (
              <NoteItem
                key={n.id}
                note={n}
                authorName={authors[n.author_id] ?? "Clinician"}
                canEdit={!!user && (user.id === n.author_id || isAdmin) && n._e2eStatus !== "e2e-locked" && n._e2eStatus !== "e2e-no-key" && n._e2eStatus !== "e2e-failed" && n._e2eStatus !== "legacy-server-enc"}
                onSave={async (body) => {
                  if (n.body_ciphertext) {
                    if (!e2e.isUnlocked) { setUnlockOpen(true); return; }
                    const enc = await encryptForRecipients(body);
                    await editEncNote({ data: { id: n.id, ...enc } });
                    await loadNotes();
                  } else {
                    const updated = await updateNoteFn({ data: { id: n.id, body } });
                    setNotes((cur) => cur.map((x) => (x.id === n.id ? { ...x, ...(updated as Note) } : x)));
                  }
                  toast.success("Note updated");
                }}
                onDelete={async () => {
                  await deleteNoteFn({ data: { id: n.id } });
                  setNotes((cur) => cur.filter((x) => x.id !== n.id));
                  toast.success("Note deleted");
                }}
              />
            ))}
          </div>
        </Card>

        <E2EUnlockModal
          open={unlockOpen}
          onOpenChange={setUnlockOpen}
          onUnlocked={() => { loadNotes(); }}
        />


        <Card className="p-5">
          <Collapsible
            open={historyOpen}
            onOpenChange={(o) => {
              setHistoryOpen(o);
              if (o && history.length === 0 && !historyLoading) loadMoreHistory(true);
            }}
          >
            <CollapsibleTrigger asChild>
              <button type="button" className="w-full flex items-center justify-between text-left">
                <div>
                  <h2 className="font-semibold">Audit trail</h2>
                  <p className="text-xs text-muted-foreground">
                    When key fields were created or changed, and by whom.
                    {historyOpen && historyTotal > 0 && (
                      <span> · Showing {history.length} of {historyTotal}</span>
                    )}
                  </p>
                </div>
                <ChevronDown className={cn("w-4 h-4 transition-transform", historyOpen && "rotate-180")} />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-4">
              {history.length === 0 && historyLoading && (
                <p className="text-xs text-muted-foreground">Loading history…</p>
              )}
              {!historyLoading && history.length === 0 && (
                <p className="text-xs text-muted-foreground">No audit entries.</p>
              )}
              <div className="space-y-3">
                {history.map((h) => (
                  <AuditEntry key={h.id} entry={h} />
                ))}
              </div>
              {history.length > 0 && historyHasMore && (
                <div ref={historySentinelRef} className="pt-3 flex justify-center">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => loadMoreHistory(false)}
                    disabled={historyLoading}
                  >
                    {historyLoading ? "Loading…" : "Load more"}
                  </Button>
                </div>
              )}
              {history.length > 0 && !historyHasMore && (
                <p className="pt-3 text-center text-xs text-muted-foreground">
                  End of history.
                </p>
              )}
            </CollapsibleContent>
          </Collapsible>
        </Card>



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

function NoteItem({
  note,
  authorName,
  canEdit,
  onSave,
  onDelete,
}: {
  note: Note;
  authorName: string;
  canEdit: boolean;
  onSave: (body: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body ?? "");
  const [busy, setBusy] = useState(false);
  const edited = (note as any).edited_at as string | null | undefined;

  const save = async () => {
    if (!draft.trim() || draft.trim() === note.body) { setEditing(false); return; }
    setBusy(true);
    try { await onSave(draft.trim()); setEditing(false); }
    catch (e: any) { toast.error(e.message ?? "Failed to update note"); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true);
    try { await onDelete(); }
    catch (e: any) { toast.error(e.message ?? "Failed to delete note"); setBusy(false); }
  };

  return (
    <div className="text-sm border-l-2 border-primary/40 pl-3 py-1 group">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <span className="text-xs font-medium flex items-center gap-2">
          {authorName}
          <E2EBadge status={note._e2eStatus} />
        </span>
        <span className="text-[11px] text-muted-foreground" title={format(new Date(note.created_at), "PPpp")}>
          {format(new Date(note.created_at), "d MMM yyyy, HH:mm")} · {formatDistanceToNow(new Date(note.created_at), { addSuffix: true })}
          {edited && (
            <span className="ml-1 italic" title={`Edited ${format(new Date(edited), "PPpp")}`}>(edited)</span>
          )}
        </span>
      </div>
      {editing ? (
        <div className="space-y-2">
          <Textarea rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={busy} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setDraft(note.body ?? ""); setEditing(false); }} disabled={busy}>
              <X className="w-3.5 h-3.5 mr-1" /> Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={busy || !draft.trim()}>
              <Save className="w-3.5 h-3.5 mr-1" /> {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      ) : note._e2eStatus === "e2e-locked" ? (
        <div className="text-xs italic text-muted-foreground flex items-center gap-1"><Lock className="w-3 h-3" /> Encrypted — unlock the noteboard to read.</div>
      ) : note._e2eStatus === "e2e-no-key" ? (
        <div className="text-xs italic text-muted-foreground flex items-center gap-1"><ShieldAlert className="w-3 h-3" /> Encrypted — you were not a recipient of this note.</div>
      ) : note._e2eStatus === "e2e-failed" ? (
        <div className="text-xs italic text-destructive flex items-center gap-1"><ShieldAlert className="w-3 h-3" /> Could not decrypt this note.</div>
      ) : note._e2eStatus === "legacy-server-enc" || note._e2eStatus === "plaintext" ? (
        <>
          <div className="whitespace-pre-wrap">{note.body}</div>
          <div className="mt-1 text-[10px] italic text-muted-foreground">Legacy note — not end-to-end encrypted.</div>
        </>
      ) : (
        <div className="whitespace-pre-wrap">{note.body}</div>
      )}
      <div className="mt-1 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <NoteHistoryButton noteId={note.id} />
        {canEdit && !editing && (
          <>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => { setDraft(note.body ?? ""); setEditing(true); }} disabled={busy}>
              <Pencil className="w-3.5 h-3.5 mr-1" /> Edit
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive hover:text-destructive" disabled={busy}>
                  <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this note?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The note will be removed for everyone. The deletion is recorded in the audit trail.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={remove} disabled={busy} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                    {busy ? "Deleting…" : "Delete note"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
      </div>
    </div>
  );
}

function E2EBadge({ status }: { status?: Note["_e2eStatus"] }) {
  const map: Record<NonNullable<Note["_e2eStatus"]>, { label: string; title: string; className: string; Icon: typeof ShieldCheck }> = {
    "e2e-decrypted":     { label: "E2E encrypted", title: "End-to-end encrypted. Decrypted in your browser with your private key.", className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30", Icon: ShieldCheck },
    "e2e-locked":        { label: "E2E encrypted", title: "End-to-end encrypted. Unlock the noteboard to decrypt.", className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30", Icon: Lock },
    "e2e-no-key":        { label: "E2E encrypted", title: "End-to-end encrypted, but you were not a recipient of this note.", className: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30", Icon: ShieldAlert },
    "e2e-failed":        { label: "Decrypt failed", title: "End-to-end encrypted, but decryption failed.", className: "bg-destructive/10 text-destructive border-destructive/30", Icon: ShieldAlert },
    "legacy-server-enc": { label: "Not E2E encrypted", title: "Legacy note — stored server-side, not end-to-end encrypted.", className: "bg-muted text-muted-foreground border-border", Icon: ShieldOff },
    "plaintext":         { label: "Not E2E encrypted", title: "Legacy plaintext note — not end-to-end encrypted.", className: "bg-muted text-muted-foreground border-border", Icon: ShieldOff },
  };
  const entry = status ? map[status] : undefined;
  if (!entry) return null;
  const { label, title, className, Icon } = entry;
  return (
    <span title={title} className={`inline-flex items-center gap-1 text-[10px] leading-none px-1.5 py-0.5 rounded border ${className}`}>
      <Icon className="w-3 h-3" /> {label}
    </span>
  );
}

function NoteHistoryButton({ noteId }: { noteId: string }) {
  const fetchHistory = useServerFn(getNoteHistory);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [entries, setEntries] = useState<Array<{
    id: string; action: string; created_at: string; user_id: string; user_name: string; diff: any;
  }>>([]);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetchHistory({ data: { note_id: noteId } });
      setEntries(res as any);
    } catch (e: any) {
      toast.error(e.message ?? "Failed to load history");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (v) load(); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs">
          <History className="w-3.5 h-3.5 mr-1" /> History
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Note audit trail</DialogTitle>
        </DialogHeader>
        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!loading && entries.length === 0 && (
          <p className="text-sm text-muted-foreground">No audit entries found.</p>
        )}
        <div className="space-y-3 max-h-[60vh] overflow-auto">
          {entries.map((e) => (
            <div key={e.id} className="text-sm border-l-2 border-muted pl-3">
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <span className="text-xs font-medium capitalize">{e.action} · {e.user_name}</span>
                <span className="text-[11px] text-muted-foreground">
                  {format(new Date(e.created_at), "d MMM yyyy, HH:mm:ss")}
                </span>
              </div>
              {e.action === "update" && e.diff?.before?.body !== undefined && (
                <div className="space-y-1 text-xs">
                  <div className="text-muted-foreground">Before:</div>
                  <div className="whitespace-pre-wrap bg-muted/50 rounded px-2 py-1">{e.diff.before.body}</div>
                  <div className="text-muted-foreground">After:</div>
                  <div className="whitespace-pre-wrap bg-muted/50 rounded px-2 py-1">{e.diff.after?.body}</div>
                </div>
              )}
              {e.action === "create" && e.diff?.body && (
                <div className="text-xs whitespace-pre-wrap bg-muted/50 rounded px-2 py-1">{e.diff.body}</div>
              )}
              {e.action === "delete" && e.diff?.body && (
                <div className="text-xs whitespace-pre-wrap bg-muted/50 rounded px-2 py-1 line-through opacity-70">{e.diff.body}</div>
              )}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

const FIELD_LABELS: Record<string, string> = {
  age: "Age",
  sex: "Sex",
  hospital_number: "Hospital number",
  current_ward: "Current ward",
  current_bed: "Bed",
  past_medical_history: "Past medical history",
  baseline_function: "Baseline function",
  dnacpr_respect: "DNACPR / ReSPECT",
  consultant_to_consultant_only: "Consultant-to-consultant only",
  referring_specialty: "Referring specialty",
  reason_for_referral: "Reason for referral",
  referral_received_at: "Referral received",
  first_seen_at: "First seen by CC",
  decision_at: "Decision",
  arrived_on_unit_at: "Arrived on unit",
  status: "Status",
  decline_reason: "Reason for declining",
  discussed_with_consultant: "Discussed with consultant",
  admission_urgency: "Admission urgency",
  accepting_consultant: "Accepting consultant",
};

const DATE_FIELDS = new Set([
  "referral_received_at",
  "first_seen_at",
  "decision_at",
  "arrived_on_unit_at",
]);

function formatAuditValue(field: string, value: string | number | boolean | null): string {
  if (value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (DATE_FIELDS.has(field) && typeof value === "string") {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return format(d, "dd MMM yyyy HH:mm");
  }
  return String(value);
}

function AuditEntry({ entry }: { entry: ReferralAuditEntry }) {
  const when = new Date(entry.created_at);
  const actionLabel =
    entry.action === "create" ? "Created" :
    entry.action === "delete" ? "Deleted" :
    "Updated";
  const actionTone =
    entry.action === "create" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/40" :
    entry.action === "delete" ? "bg-destructive/10 text-destructive border-destructive/40" :
    "bg-muted text-foreground border-border";

  return (
    <div className="border rounded-md p-3 text-sm">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={cn("capitalize", actionTone)}>{actionLabel}</Badge>
          <span className="font-medium">{entry.user_name}</span>
        </div>
        <span
          className="text-xs text-muted-foreground"
          title={format(when, "dd MMM yyyy HH:mm:ss")}
        >
          {format(when, "dd MMM yyyy HH:mm")} · {formatDistanceToNow(when, { addSuffix: true })}
        </span>
      </div>

      {entry.action === "create" && entry.snapshot && (
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
          {Object.entries(entry.snapshot)
            .filter(([, v]) => v !== null && v !== "")
            .map(([k, v]) => (
              <div key={k} className="flex gap-1">
                <dt className="text-muted-foreground">{FIELD_LABELS[k] ?? k}:</dt>
                <dd className="break-words">{formatAuditValue(k, v)}</dd>
              </div>
            ))}
        </dl>
      )}

      {entry.action === "update" && entry.changes.length > 0 && (
        <ul className="space-y-1 text-xs">
          {entry.changes.map((c) => (
            <li key={c.field}>
              <span className="text-muted-foreground">{FIELD_LABELS[c.field] ?? c.field}:</span>{" "}
              <span className="line-through text-muted-foreground">{formatAuditValue(c.field, c.from)}</span>
              {" → "}
              <span className="font-medium">{formatAuditValue(c.field, c.to)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

