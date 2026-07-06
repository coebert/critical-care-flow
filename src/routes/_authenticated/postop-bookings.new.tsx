import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { createPostopBooking } from "@/lib/postop-bookings.functions";
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
import { toast } from "sonner";
import { ArrowLeft } from "lucide-react";
import {
  SURGICAL_SPECIALTY_LABEL,
  SURGICAL_SPECIALTY_OPTIONS,
  type SurgicalSpecialty,
} from "@/lib/surgical-specialties";

export const Route = createFileRoute("/_authenticated/postop-bookings/new")({
  head: () => ({
    meta: [{ title: "New post-op HDU/ICU booking — SDH Critical Care" }],
  }),
  component: NewPostopBookingPage,
});

type Level = "level_1" | "level_2" | "level_3";
type Sex = "" | "male" | "female" | "other" | "unknown";

const LEVEL_LABEL: Record<Level, string> = {
  level_1: "Level 1 — Ward with additional monitoring/input",
  level_2: "Level 2 — HDU / single organ support",
  level_3: "Level 3 — ICU / multi-organ support or ventilation",
};

function NewPostopBookingPage() {
  const navigate = useNavigate();
  const submit = useServerFn(createPostopBooking);
  const [saving, setSaving] = useState(false);

  const [hospitalNumber, setHospitalNumber] = useState("");
  const [age, setAge] = useState("");
  const [sex, setSex] = useState<Sex>("");
  const [weight, setWeight] = useState("");
  const [height, setHeight] = useState("");
  const [procedure, setProcedure] = useState("");
  const [pmh, setPmh] = useState("");
  const [psh, setPsh] = useState("");
  const [social, setSocial] = useState("");
  const [reason, setReason] = useState("");
  const [level, setLevel] = useState<Level | "">("");
  const [surgeryDate, setSurgeryDate] = useState("");
  const [specialty, setSpecialty] = useState<SurgicalSpecialty | "">("");
  const [isTest, setIsTest] = useState(false);

  const bmi = useMemo(() => {
    const w = parseFloat(weight);
    const hCm = parseFloat(height);
    if (!isFinite(w) || !isFinite(hCm) || w <= 0 || hCm <= 0) return null;
    const hM = hCm / 100;
    return Math.round((w / (hM * hM)) * 10) / 10;
  }, [weight, height]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!level) {
      toast.error("Please select the predicted level of support");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        hospital_number: hospitalNumber.trim() || null,
        age: age.trim() ? parseInt(age, 10) : null,
        sex: (sex || null) as any,
        weight_kg: weight.trim() ? parseFloat(weight) : null,
        height_cm: height.trim() ? parseFloat(height) : null,
        bmi: bmi ?? null,
        proposed_procedure: procedure.trim() || null,
        past_medical_history: pmh.trim() || null,
        past_surgical_history: psh.trim() || null,
        social_history: social.trim() || null,
        reason_for_bed: reason.trim() || null,
        predicted_level: level as Level,
        proposed_surgery_date: surgeryDate.trim() || null,
        surgical_specialty: specialty || null,
        is_test: isTest,
      };
      await submit({ data: payload });
      toast.success("Post-op booking saved");
      navigate({ to: "/postop-bookings" });
    } catch (err: any) {
      toast.error(err?.message ?? "Could not save booking");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/postop-bookings"><ArrowLeft className="w-4 h-4 mr-1" />Back</Link>
        </Button>
      </div>
      <div>
        <h1 className="text-2xl font-semibold">New post-op HDU/ICU booking</h1>
        <p className="text-sm text-muted-foreground">
          Pre-book a critical care bed for a high-risk elective/planned surgical patient.
          This is tracked separately from acute referrals.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-6">
        <Card className="p-4 sm:p-6 space-y-4">
          <h2 className="font-semibold">Patient details</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="hn">Hospital number</Label>
              <Input id="hn" value={hospitalNumber} onChange={(e) => setHospitalNumber(e.target.value)} maxLength={50} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="age">Age (years)</Label>
              <Input id="age" type="number" min={0} max={130} value={age} onChange={(e) => setAge(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Sex</Label>
              <Select value={sex} onValueChange={(v) => setSex(v as Sex)}>
                <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="male">Male</SelectItem>
                  <SelectItem value="female">Female</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                  <SelectItem value="unknown">Unknown</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="weight">Weight (kg)</Label>
                <Input id="weight" type="number" step="0.1" min={0} value={weight} onChange={(e) => setWeight(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="height">Height (cm)</Label>
                <Input id="height" type="number" step="0.1" min={0} value={height} onChange={(e) => setHeight(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>BMI</Label>
                <Input value={bmi ?? ""} readOnly placeholder="—" />
              </div>
            </div>
          </div>
        </Card>

        <Card className="p-4 sm:p-6 space-y-4">
          <h2 className="font-semibold">Surgical plan</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="proc">Proposed surgical procedure</Label>
              <Textarea id="proc" rows={2} value={procedure} onChange={(e) => setProcedure(e.target.value)} maxLength={2000} />
            </div>
            <div className="space-y-1.5">
              <Label>Surgical specialty</Label>
              <Select value={specialty} onValueChange={(v) => setSpecialty(v as SurgicalSpecialty)}>
                <SelectTrigger><SelectValue placeholder="Select specialty" /></SelectTrigger>
                <SelectContent>
                  {SURGICAL_SPECIALTY_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>{SURGICAL_SPECIALTY_LABEL[s]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="surgery-date">Proposed date of surgery</Label>
              <Input id="surgery-date" type="date" value={surgeryDate} onChange={(e) => setSurgeryDate(e.target.value)} />
              <p className="text-xs text-muted-foreground">Leave blank if not yet known.</p>
            </div>
            <div className="space-y-1.5">
              <Label>Predicted level of support required *</Label>
              <Select value={level} onValueChange={(v) => setLevel(v as Level)}>
                <SelectTrigger><SelectValue placeholder="Select level" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="level_1">{LEVEL_LABEL.level_1}</SelectItem>
                  <SelectItem value="level_2">{LEVEL_LABEL.level_2}</SelectItem>
                  <SelectItem value="level_3">{LEVEL_LABEL.level_3}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reason">Reason for requesting post-op HDU/ICU bed</Label>
            <Textarea id="reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
          </div>
        </Card>

        <Card className="p-4 sm:p-6 space-y-4">
          <h2 className="font-semibold">Background</h2>
          <div className="space-y-1.5">
            <Label htmlFor="pmh">Past medical history</Label>
            <Textarea id="pmh" rows={4} value={pmh} onChange={(e) => setPmh(e.target.value)} maxLength={5000} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="psh">Past surgical history</Label>
            <Textarea id="psh" rows={4} value={psh} onChange={(e) => setPsh(e.target.value)} maxLength={5000} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="social">Social history / functional baseline</Label>
            <Textarea id="social" rows={3} value={social} onChange={(e) => setSocial(e.target.value)} maxLength={2000} />
          </div>
        </Card>

        <Card className="p-4 sm:p-6 space-y-2 border-amber-400/60 bg-amber-50/40 dark:bg-amber-950/20">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="is-test" className="text-sm font-medium cursor-pointer">
                Test / demonstration booking
              </Label>
              <p className="text-xs text-muted-foreground">
                Mark this booking as a test entry (not a real patient). Test
                bookings are shown with a badge and are excluded from analytics.
              </p>
            </div>
            <Switch id="is-test" checked={isTest} onCheckedChange={setIsTest} />
          </div>
        </Card>


        <div className="flex gap-2 justify-end">
          <Button type="button" variant="ghost" asChild disabled={saving}>
            <Link to="/postop-bookings">Cancel</Link>
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save booking"}
          </Button>
        </div>
      </form>
    </div>
  );
}
