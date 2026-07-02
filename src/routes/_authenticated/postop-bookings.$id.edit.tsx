import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { getPostopBooking, updatePostopBooking, getPostopBookingHistory, type PostopAuditEntry } from "@/lib/postop-bookings.functions";
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
import { toast } from "sonner";
import { ArrowLeft } from "lucide-react";

export const Route = createFileRoute("/_authenticated/postop-bookings/$id/edit")({
  head: () => ({
    meta: [{ title: "Edit post-op HDU/ICU booking — SDH Critical Care" }],
  }),
  component: EditPostopBookingPage,
});

type Level = "level_1" | "level_2" | "level_3";
type Sex = "" | "male" | "female" | "other" | "unknown";

const LEVEL_LABEL: Record<Level, string> = {
  level_1: "Level 1 — Ward with additional monitoring/input",
  level_2: "Level 2 — HDU / single organ support",
  level_3: "Level 3 — ICU / multi-organ support or ventilation",
};

function EditPostopBookingPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const load = useServerFn(getPostopBooking);
  const loadHistory = useServerFn(getPostopBookingHistory);
  const submit = useServerFn(updatePostopBooking);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<PostopAuditEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

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
  const [arrivedAt, setArrivedAt] = useState("");

  useEffect(() => {
    let cancelled = false;
    load({ data: { id } })
      .then((row: any) => {
        if (cancelled) return;
        setHospitalNumber(row.hospital_number ?? "");
        setAge(row.age != null ? String(row.age) : "");
        setSex((row.sex ?? "") as Sex);
        setWeight(row.weight_kg != null ? String(row.weight_kg) : "");
        setHeight(row.height_cm != null ? String(row.height_cm) : "");
        setProcedure(row.proposed_procedure ?? "");
        setPmh(row.past_medical_history ?? "");
        setPsh(row.past_surgical_history ?? "");
        setSocial(row.social_history ?? "");
        setReason(row.reason_for_bed ?? "");
        setLevel(row.predicted_level ?? "");
        setSurgeryDate(row.proposed_surgery_date ?? "");
        setArrivedAt(row.arrived_at ? new Date(row.arrived_at).toISOString().slice(0, 16) : "");
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err?.message ?? "Could not load booking");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, load]);

  useEffect(() => {
    let cancelled = false;
    loadHistory({ data: { id } })
      .then((rows) => { if (!cancelled) setHistory(rows); })
      .catch(() => { if (!cancelled) setHistory([]); })
      .finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [id, loadHistory]);

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
      await submit({
        data: {
          id,
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
        },
      });
      toast.success("Post-op booking updated");
      navigate({ to: "/postop-bookings" });
    } catch (err: any) {
      toast.error(err?.message ?? "Could not update booking");
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
        <h1 className="text-2xl font-semibold">Edit post-op HDU/ICU booking</h1>
        <p className="text-sm text-muted-foreground">
          Update details for this pre-booked critical care bed.
        </p>
      </div>

      {loadError && (
        <Card className="p-4 border-destructive/50 text-destructive text-sm">{loadError}</Card>
      )}

      {loading && !loadError && (
        <Card className="p-6 text-sm text-muted-foreground">Loading…</Card>
      )}

      {!loading && !loadError && (
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
            <div className="space-y-1.5">
              <Label htmlFor="proc">Proposed surgical procedure</Label>
              <Textarea id="proc" rows={2} value={procedure} onChange={(e) => setProcedure(e.target.value)} maxLength={2000} />
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

          <div className="flex gap-2 justify-end">
            <Button type="button" variant="ghost" asChild disabled={saving}>
              <Link to="/postop-bookings">Cancel</Link>
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      )}

      <Card className="p-4 sm:p-6 space-y-3">
        <div>
          <h2 className="font-semibold">Audit trail</h2>
          <p className="text-xs text-muted-foreground">
            Who created or updated this booking and when. Sensitive free-text
            changes are shown as “[redacted]” to protect patient data.
          </p>
        </div>
        {historyLoading ? (
          <p className="text-sm text-muted-foreground">Loading history…</p>
        ) : history.length === 0 ? (
          <p className="text-sm text-muted-foreground">No audit entries yet.</p>
        ) : (
          <ol className="space-y-3">
            {history.map((e) => (
              <li key={e.id} className="border-l-2 border-muted pl-3">
                <div className="text-sm">
                  <span className="font-medium capitalize">{e.action}</span>
                  {" by "}
                  <span className="font-medium">{e.user_name}</span>
                  {" · "}
                  <span className="text-muted-foreground">
                    {new Date(e.created_at).toLocaleString()}
                  </span>
                </div>
                {e.action === "update" && e.changes.length > 0 && (
                  <ul className="mt-1 text-xs text-muted-foreground space-y-0.5">
                    {e.changes.map((c, i) => (
                      <li key={i}>
                        <span className="font-medium text-foreground">{c.field}</span>
                        : {String(c.from ?? "—")} → {String(c.to ?? "—")}
                      </li>
                    ))}
                  </ul>
                )}
                {e.action === "create" && e.snapshot && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Booking created with initial details.
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
