import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { addNote, deleteReferral, logReferralView, updateReferral } from "@/lib/referrals.functions";
import { useRole } from "@/hooks/use-auth";
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
import { ArrowLeft, Save, Trash2 } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";


type Referral = Tables<"referrals">;
type Note = Tables<"referral_notes">;

export const Route = createFileRoute("/_authenticated/referrals/$id")({
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
  const navigate = useNavigate();
  const update = useServerFn(updateReferral);
  const addNoteFn = useServerFn(addNote);
  const logView = useServerFn(logReferralView);
  const removeReferral = useServerFn(deleteReferral);
  const { hasRole: isAdmin } = useRole("admin");
  const [deleting, setDeleting] = useState(false);


  const [ref, setRef] = useState<Referral | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [authors, setAuthors] = useState<Record<string, string>>({});
  const [noteBody, setNoteBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    logView({ data: { referral_id: id } }).catch(() => {});
    supabase.from("referrals").select("*").eq("id", id).maybeSingle().then(({ data }) => setRef(data));
    supabase
      .from("referral_notes")
      .select("*")
      .eq("referral_id", id)
      .order("created_at", { ascending: false })
      .then(async ({ data }) => {
        setNotes(data ?? []);
        const ids = Array.from(new Set((data ?? []).map((n) => n.author_id)));
        if (ids.length) {
          const { data: ps } = await supabase.from("profiles").select("id,full_name").in("id", ids);
          const map: Record<string, string> = {};
          ps?.forEach((p) => { map[p.id] = p.full_name ?? "Clinician"; });
          setAuthors(map);
        }
      });

    const ch = supabase
      .channel(`ref-${id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "referrals", filter: `id=eq.${id}` },
        (p) => setRef(p.new as Referral))
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "referral_notes", filter: `referral_id=eq.${id}` },
        (p) => setNotes((cur) => [p.new as Note, ...cur]))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [id, logView]);

  if (!ref) return <div className="p-6 text-muted-foreground">Loading…</div>;

  const set = (k: keyof Referral, v: any) => setRef({ ...ref, [k]: v });

  const save = async () => {
    setSaving(true);
    try {
      const patch: any = {
        age: ref.age, sex: ref.sex, hospital_number: ref.hospital_number,
        current_ward: ref.current_ward, current_bed: ref.current_bed,
        past_medical_history: ref.past_medical_history, baseline_function: ref.baseline_function,
        dnacpr_respect: ref.dnacpr_respect, referring_specialty: ref.referring_specialty,
        reason_for_referral: ref.reason_for_referral, status: ref.status,
        decline_reason: ref.decline_reason,
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

  const postNote = async () => {
    if (!noteBody.trim()) return;
    setPosting(true);
    try {
      await addNoteFn({ data: { referral_id: id, body: noteBody.trim() } });
      setNoteBody("");
    } catch (err: any) {
      toast.error(err.message ?? "Failed to post note");
    } finally {
      setPosting(false);
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

  const statusStyles: Record<string, string> = {
    pending: "bg-warning/15 text-warning-foreground border-warning/30",
    admitted: "bg-success/15 text-success border-success/30",
    declined: "bg-destructive/10 text-destructive border-destructive/30",
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: "/" })}><ArrowLeft className="w-4 h-4 mr-1" /> Back to list</Button>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={`capitalize ${statusStyles[ref.status]}`}>{ref.status}</Badge>
          {isAdmin && (
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
      <p className="text-sm text-muted-foreground mb-6">
        Received {format(new Date(ref.referral_received_at), "PPpp")}
      </p>

      <div className="grid md:grid-cols-3 gap-6">
        <div className="md:col-span-2 space-y-4">
          <Card className="p-5 space-y-4">
            <h2 className="font-semibold">Details</h2>
            <div className="grid grid-cols-2 gap-4">
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
            <F label="Past medical history"><Textarea rows={3} value={ref.past_medical_history ?? ""} onChange={(e) => set("past_medical_history", e.target.value)} /></F>
            <F label="Baseline function"><Textarea rows={2} value={ref.baseline_function ?? ""} onChange={(e) => set("baseline_function", e.target.value)} /></F>
            <F label="Reason for referral"><Textarea rows={3} value={ref.reason_for_referral ?? ""} onChange={(e) => set("reason_for_referral", e.target.value)} /></F>
            <div className="flex items-center gap-3">
              <Switch checked={ref.dnacpr_respect} onCheckedChange={(v) => set("dnacpr_respect", v)} id="dn" />
              <Label htmlFor="dn">DNACPR / ReSPECT in place</Label>
            </div>
          </Card>

          <Card className="p-5 space-y-4">
            <h2 className="font-semibold">Timeline (ICNARC)</h2>
            <div className="grid grid-cols-2 gap-4">
              <F label="Received"><DTNow value={toLocal(ref.referral_received_at)} onChange={(v) => set("referral_received_at", new Date(v).toISOString())} /></F>
              <F label="First seen"><DTNow value={toLocal(ref.first_seen_at)} onChange={(v) => set("first_seen_at", v ? new Date(v).toISOString() : null)} /></F>
              <F label="Decision"><DTNow value={toLocal(ref.decision_at)} onChange={(v) => set("decision_at", v ? new Date(v).toISOString() : null)} /></F>
              <F label="Arrived on unit"><DTNow value={toLocal(ref.arrived_on_unit_at)} onChange={(v) => set("arrived_on_unit_at", v ? new Date(v).toISOString() : null)} /></F>
            </div>
          </Card>

          <Card className="p-5 space-y-4">
            <h2 className="font-semibold">Outcome</h2>
            <div className="grid grid-cols-2 gap-4">
              <F label="Status">
                <Select value={ref.status} onValueChange={(v) => set("status", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="admitted">Admitted</SelectItem>
                    <SelectItem value="declined">Declined</SelectItem>
                  </SelectContent>
                </Select>
              </F>
            </div>
            {ref.status === "declined" && (
              <F label="Reason for declining"><Textarea rows={3} value={ref.decline_reason ?? ""} onChange={(e) => set("decline_reason", e.target.value)} /></F>
            )}
          </Card>

          <div className="flex justify-end">
            <Button onClick={save} disabled={saving}><Save className="w-4 h-4 mr-1" />{saving ? "Saving…" : "Save changes"}</Button>
          </div>
        </div>

        <div className="space-y-4">
          <Card className="p-5">
            <h2 className="font-semibold mb-3">Notes</h2>
            <div className="space-y-2 mb-3">
              <Textarea rows={3} value={noteBody} onChange={(e) => setNoteBody(e.target.value)} placeholder="e.g. seen in ED resus, awaiting bloods, for re-review at 6pm" />
              <Button size="sm" onClick={postNote} disabled={posting || !noteBody.trim()} className="w-full">
                {posting ? "Posting…" : "Add note"}
              </Button>
            </div>
            <div className="space-y-3 max-h-[480px] overflow-auto">
              {notes.length === 0 && <p className="text-xs text-muted-foreground">No notes yet.</p>}
              {notes.map((n) => (
                <div key={n.id} className="text-sm border-l-2 border-primary/40 pl-3">
                  <div className="whitespace-pre-wrap">{n.body}</div>
                  <div className="text-[11px] text-muted-foreground mt-1">
                    {authors[n.author_id] ?? "Clinician"} · {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function F({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><Label className="text-xs">{label}</Label>{children}</div>;
}

function nowLocal() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function DTNow({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-2">
      <Input type="datetime-local" value={value} onChange={(e) => onChange(e.target.value)} />
      <Button type="button" variant="outline" size="sm" onClick={() => onChange(nowLocal())}>Now</Button>
    </div>
  );
}
