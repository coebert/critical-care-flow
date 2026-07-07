import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import type { Database } from "@/integrations/supabase/types";
import { AlertTriangle, ArrowRightLeft, Plus, X } from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";

type Outlier = Database["public"]["Tables"]["bed_outliers"]["Row"];
type Transfer = Database["public"]["Tables"]["bed_transfers_out"]["Row"];

export function OutliersPanel({
  outliers,
  onCreate,
  onEnd,
  saving,
}: {
  outliers: Outlier[];
  onCreate: (v: { ward: string; patient_initials: string | null; hospital_number: string | null; reason: string | null }) => void;
  onEnd: (id: string) => void;
  saving?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [ward, setWard] = useState("");
  const [initials, setInitials] = useState("");
  const [hn, setHn] = useState("");
  const [reason, setReason] = useState("");
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" aria-hidden="true" />
          Ward outliers ({outliers.length})
        </h3>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <Plus className="w-3.5 h-3.5 mr-1" />Add
        </Button>
      </div>
      {outliers.length === 0 && (
        <p className="text-xs text-muted-foreground">No level-2 patients on the wards.</p>
      )}
      <ul className="space-y-2">
        {outliers.map((o) => (
          <li key={o.id} className="flex items-start justify-between gap-2 text-sm border rounded p-2">
            <div className="min-w-0">
              <div className="font-medium">
                {o.patient_initials || "—"}{" "}
                <span className="text-xs text-muted-foreground">
                  {o.hospital_number ? `· ${o.hospital_number}` : ""}
                </span>
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {o.ward} · L{o.level} · since {formatDistanceToNowStrict(new Date(o.started_at), { addSuffix: true })}
              </div>
              {o.reason && <div className="text-xs text-muted-foreground truncate">{o.reason}</div>}
            </div>
            <Button size="icon" variant="ghost" onClick={() => onEnd(o.id)} disabled={saving} aria-label="End outlier">
              <X className="w-4 h-4" />
            </Button>
          </li>
        ))}
      </ul>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add ward outlier</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="o-ward">Ward *</Label>
                <Input id="o-ward" value={ward} onChange={(e) => setWard(e.target.value)} maxLength={120} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="o-init">Initials</Label>
                <Input id="o-init" value={initials} onChange={(e) => setInitials(e.target.value)} maxLength={10} />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="o-hn">Hospital number</Label>
              <Input id="o-hn" value={hn} onChange={(e) => setHn(e.target.value)} maxLength={50} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="o-reason">Reason</Label>
              <Textarea id="o-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              disabled={!ward.trim() || saving}
              onClick={() => {
                onCreate({
                  ward: ward.trim(),
                  patient_initials: initials.trim() || null,
                  hospital_number: hn.trim() || null,
                  reason: reason.trim() || null,
                });
                setWard(""); setInitials(""); setHn(""); setReason("");
                setOpen(false);
              }}
            >
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

const STATUS_LABEL: Record<Transfer["status"], string> = {
  requested: "Requested",
  accepted: "Accepted",
  awaiting_transport: "Awaiting transport",
  in_transit: "In transit",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function TransfersPanel({
  transfers,
  onCreate,
  onAdvance,
  onCancel,
  saving,
}: {
  transfers: Transfer[];
  onCreate: (v: {
    destination_hospital: string;
    kind: "repat" | "tertiary" | "other";
    reason: string | null;
    destination_specialty: string | null;
    transport_mode: "land_ambulance" | "air" | "self" | "other" | null;
  }) => void;
  onAdvance: (id: string, next: Transfer["status"]) => void;
  onCancel: (id: string) => void;
  saving?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [dest, setDest] = useState("");
  const [kind, setKind] = useState<"repat" | "tertiary" | "other">("repat");
  const [spec, setSpec] = useState("");
  const [mode, setMode] = useState<"land_ambulance" | "air" | "self" | "other" | "">("");
  const [reason, setReason] = useState("");
  const nextStatus = (s: Transfer["status"]): Transfer["status"] | null => {
    if (s === "requested") return "accepted";
    if (s === "accepted") return "awaiting_transport";
    if (s === "awaiting_transport") return "in_transit";
    if (s === "in_transit") return "completed";
    return null;
  };
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-sm flex items-center gap-2">
          <ArrowRightLeft className="w-4 h-4" aria-hidden="true" />
          Transfers out ({transfers.length})
        </h3>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <Plus className="w-3.5 h-3.5 mr-1" />Add
        </Button>
      </div>
      {transfers.length === 0 && (
        <p className="text-xs text-muted-foreground">No open transfers.</p>
      )}
      <ul className="space-y-2">
        {transfers.map((t) => {
          const next = nextStatus(t.status);
          return (
            <li key={t.id} className="border rounded p-2 text-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium truncate">{t.destination_hospital}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {t.kind} · {t.destination_specialty ?? "—"}
                  </div>
                </div>
                <Badge variant="outline" className="text-[10px]">{STATUS_LABEL[t.status]}</Badge>
              </div>
              <div className="flex gap-2 mt-2">
                {next && (
                  <Button size="sm" variant="outline" disabled={saving} onClick={() => onAdvance(t.id, next)}>
                    → {STATUS_LABEL[next]}
                  </Button>
                )}
                <Button size="sm" variant="ghost" disabled={saving} onClick={() => onCancel(t.id)}>
                  Cancel
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New transfer out</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="t-dest">Destination hospital *</Label>
              <Input id="t-dest" value={dest} onChange={(e) => setDest(e.target.value)} maxLength={160} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Kind</Label>
                <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="repat">Repatriation</SelectItem>
                    <SelectItem value="tertiary">Tertiary transfer</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="t-spec">Specialty</Label>
                <Input id="t-spec" value={spec} onChange={(e) => setSpec(e.target.value)} maxLength={120} />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Transport</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
                <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="land_ambulance">Land ambulance</SelectItem>
                  <SelectItem value="air">Air</SelectItem>
                  <SelectItem value="self">Self / relatives</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="t-reason">Reason</Label>
              <Textarea id="t-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              disabled={!dest.trim() || saving}
              onClick={() => {
                onCreate({
                  destination_hospital: dest.trim(),
                  kind,
                  reason: reason.trim() || null,
                  destination_specialty: spec.trim() || null,
                  transport_mode: (mode || null) as "land_ambulance" | "air" | "self" | "other" | null,
                });
                setDest(""); setSpec(""); setReason(""); setMode(""); setKind("repat");
                setOpen(false);
              }}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
