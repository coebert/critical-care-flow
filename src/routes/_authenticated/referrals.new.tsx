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

type PriorReferral = {
  id: string;
  hospital_number: string | null;
  referral_received_at: string;
  status: string;
  referring_specialty: string | null;
  current_ward: string | null;
  current_bed: string | null;
  reason_for_referral: string | null;
  age: number | null;
  sex: string | null;
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

function NewReferralPage() {
  const navigate = useNavigate();
  const create = useServerFn(createReferral);
  const [saving, setSaving] = useState(false);
  const { specialties, wards } = useReferralOptions();
  const [f, setF] = useState({
    age: "",
    sex: "unknown" as "male" | "female" | "other" | "unknown",
    hospital_number: "",
    current_ward: "",
    current_bed: "",
    past_medical_history: "",
    baseline_function: "",
    dnacpr_respect: false,
    referring_specialty: "",
    reason_for_referral: "",
    referral_received_at: localISO(),
    first_seen_at: "",
    decision_at: "",
    arrived_on_unit_at: "",
    status: "pending" as "pending" | "declined" | "admitted",
    decline_reason: "",
  });

  const set = (k: keyof typeof f, v: any) => setF((cur) => ({ ...cur, [k]: v }));

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
        if (!cancelled) setPriors((res ?? []) as PriorReferral[]);
      } catch {
        if (!cancelled) setPriors([]);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [f.hospital_number, findPrior]);

  const showAlert =
    priors.length > 0 && dismissedFor !== f.hospital_number.trim();


  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload: any = {
        ...f,
        age: f.age ? Number(f.age) : null,
        referral_received_at: new Date(f.referral_received_at).toISOString(),
        first_seen_at: f.first_seen_at ? new Date(f.first_seen_at).toISOString() : null,
        decision_at: f.decision_at ? new Date(f.decision_at).toISOString() : null,
        arrived_on_unit_at: f.arrived_on_unit_at ? new Date(f.arrived_on_unit_at).toISOString() : null,
      };
      for (const k of [
        "hospital_number","current_ward","current_bed","past_medical_history",
        "baseline_function","referring_specialty","reason_for_referral","decline_reason",
      ]) if (!payload[k]) payload[k] = null;

      const res = await create({ data: payload });
      toast.success("Referral saved");
      navigate({ to: "/referrals/$id", params: { id: (res as any).id } });
    } catch (err: any) {
      toast.error(err.message ?? "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-semibold tracking-tight mb-6">New referral</h1>
      <form onSubmit={submit} className="space-y-6">
        <Section title="Patient">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Age"><Input type="number" min="0" max="130" value={f.age} onChange={(e) => set("age", e.target.value)} /></Field>
            <Field label="Sex">
              <Select value={f.sex} onValueChange={(v) => set("sex", v)}>
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
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={() => setPriorOpen(true)}>
                    View previous referrals for this patient
                  </Button>
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
        </Section>


        <Section title="Timestamps">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Referral received"><DateTimeNow value={f.referral_received_at} onChange={(v) => set("referral_received_at", v)} /></Field>
            <Field label="First seen by CC"><DateTimeNow value={f.first_seen_at} onChange={(v) => set("first_seen_at", v)} /></Field>
            <Field label="Decision to admit / decline"><DateTimeNow value={f.decision_at} onChange={(v) => set("decision_at", v)} /></Field>
            <Field label="Arrived on unit"><DateTimeNow value={f.arrived_on_unit_at} onChange={(v) => set("arrived_on_unit_at", v)} /></Field>
          </div>
        </Section>

        <Section title="Clinical">
          <Field label="Past medical history"><Textarea rows={3} value={f.past_medical_history} onChange={(e) => set("past_medical_history", e.target.value)} /></Field>
          <Field label="Baseline level of function"><Textarea rows={2} value={f.baseline_function} onChange={(e) => set("baseline_function", e.target.value)} placeholder="e.g. independent, MRC dyspnoea 2, lives alone" /></Field>
          <Field label="Reason for referral"><Textarea rows={3} value={f.reason_for_referral} onChange={(e) => set("reason_for_referral", e.target.value)} /></Field>
          <div className="flex items-center gap-3">
            <Switch id="dnacpr" checked={f.dnacpr_respect} onCheckedChange={(v) => set("dnacpr_respect", v)} />
            <Label htmlFor="dnacpr">DNACPR / ReSPECT form already in place</Label>
          </div>
        </Section>

        <Section title="Outcome">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Status">
              <Select value={f.status} onValueChange={(v) => set("status", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="admitted">Admitted</SelectItem>
                  <SelectItem value="declined">Declined</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          {f.status === "declined" && (
            <Field label="Reason for declining"><Textarea rows={3} value={f.decline_reason} onChange={(e) => set("decline_reason", e.target.value)} /></Field>
          )}
        </Section>

        <Section title="Noteboard">
          <p className="text-sm text-muted-foreground">
            The team noteboard becomes available after you save this referral. Save the referral, then post notes for other clinicians to see — each note is tagged with your name and the time it was written.
          </p>
        </Section>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => navigate({ to: "/" })}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save referral"}</Button>
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
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

function DateTimeNow({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-2">
      <Input type="datetime-local" value={value} onChange={(e) => onChange(e.target.value)} className={!value ? "text-muted-foreground" : ""} />
      <Button type="button" variant="outline" size="sm" onClick={() => onChange(localISO())}>Now</Button>
    </div>
  );
}
