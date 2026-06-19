import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { createReferral } from "@/lib/referrals.functions";
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
import { ComboboxAdd } from "@/components/combobox-add";
import { useReferralOptions } from "@/hooks/use-referral-options";
import { toast } from "sonner";

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
