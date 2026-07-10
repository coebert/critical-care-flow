import { useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Database } from "@/integrations/supabase/types";

type Bed = Database["public"]["Tables"]["beds"]["Row"];
type Occ = Database["public"]["Tables"]["bed_occupancies"]["Row"];

export interface OccupancyFormValue {
  hospital_number: string | null;
  patient_initials: string | null;
  admitting_consultant: string | null;
  level: 0 | 1 | 2 | 3;
  wardable: boolean;
  ventilated: boolean;
  nippv_cpap: boolean;
  hfno: boolean;
  vasopressors: boolean;
  renal_replacement: boolean;
  tracheostomy: boolean;
  isolation: "none" | "contact" | "droplet" | "airborne";
  isolation_reason: string | null;
  requires_side_room: boolean;
  predicted_discharge_at: string | null; // yyyy-MM-ddTHH:mm
  predicted_step_down: "ward" | "hdu" | "home" | "other" | null;
  notes: string | null;
}

function emptyValue(): OccupancyFormValue {
  return {
    hospital_number: null,
    patient_initials: null,
    admitting_consultant: null,
    level: 3,
    wardable: false,
    ventilated: false,
    nippv_cpap: false,
    hfno: false,
    vasopressors: false,
    renal_replacement: false,
    tracheostomy: false,
    isolation: "none",
    isolation_reason: null,
    requires_side_room: false,
    predicted_discharge_at: null,
    predicted_step_down: null,
    notes: null,
  };
}

function fromOcc(o: Occ): OccupancyFormValue {
  return {
    hospital_number: o.hospital_number,
    patient_initials: o.patient_initials,
    admitting_consultant: o.admitting_consultant,
    level: (o.level ?? 3) as 0 | 1 | 2 | 3,
    wardable: (o as { wardable?: boolean }).wardable ?? false,
    ventilated: o.ventilated,
    nippv_cpap: o.nippv_cpap,
    hfno: o.hfno,
    vasopressors: o.vasopressors,
    renal_replacement: o.renal_replacement,
    tracheostomy: o.tracheostomy,
    isolation: o.isolation as OccupancyFormValue["isolation"],
    isolation_reason: o.isolation_reason,
    requires_side_room: o.requires_side_room,
    predicted_discharge_at: o.predicted_discharge_at
      ? new Date(o.predicted_discharge_at).toISOString().slice(0, 16)
      : null,
    predicted_step_down: o.predicted_step_down as OccupancyFormValue["predicted_step_down"],
    notes: o.notes,
  };
}

function OccupancyForm({
  value,
  onChange,
}: {
  value: OccupancyFormValue;
  onChange: (patch: Partial<OccupancyFormValue>) => void;
}) {
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="initials">Initials</Label>
          <Input
            id="initials"
            value={value.patient_initials ?? ""}
            onChange={(e) => onChange({ patient_initials: e.target.value || null })}
            maxLength={10}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="hn">Hospital number</Label>
          <Input
            id="hn"
            value={value.hospital_number ?? ""}
            onChange={(e) => onChange({ hospital_number: e.target.value || null })}
            maxLength={50}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="cons">Consultant</Label>
          <Input
            id="cons"
            value={value.admitting_consultant ?? ""}
            onChange={(e) => onChange({ admitting_consultant: e.target.value || null })}
            maxLength={120}
          />
        </div>
        <div className="space-y-1">
          <Label>Level of care</Label>
          <Select
            value={String(value.level)}
            onValueChange={(v) => onChange({ level: Number(v) as 0 | 1 | 2 | 3 })}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="0">Level 0 (ward-level)</SelectItem>
              <SelectItem value="1">Level 1</SelectItem>
              <SelectItem value="2">Level 2 (HDU)</SelectItem>
              <SelectItem value="3">Level 3 (ICU)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <Checkbox
          checked={value.wardable}
          onCheckedChange={(c) => onChange({ wardable: !!c })}
        />
        <span>Wardable — ready for a ward bed</span>
      </label>
      <fieldset className="rounded-md border p-3">
        <legend className="text-xs font-medium px-1">Organ support</legend>
        <div className="grid grid-cols-2 gap-2 text-sm">
          {([
            ["ventilated", "Ventilated"],
            ["nippv_cpap", "NIV / CPAP"],
            ["hfno", "HFNO"],
            ["vasopressors", "Vasopressors"],
            ["renal_replacement", "RRT"],
            ["tracheostomy", "Tracheostomy"],
          ] as const).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={value[k]}
                onCheckedChange={(c) => onChange({ [k]: !!c } as Partial<OccupancyFormValue>)}
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>Isolation</Label>
          <Select
            value={value.isolation}
            onValueChange={(v) => onChange({ isolation: v as OccupancyFormValue["isolation"] })}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="contact">Contact</SelectItem>
              <SelectItem value="droplet">Droplet</SelectItem>
              <SelectItem value="airborne">Airborne</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="iso-reason">Isolation reason</Label>
          <Input
            id="iso-reason"
            value={value.isolation_reason ?? ""}
            onChange={(e) => onChange({ isolation_reason: e.target.value || null })}
            disabled={value.isolation === "none"}
            maxLength={200}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="pred-dc">Predicted discharge</Label>
          <Input
            id="pred-dc"
            type="datetime-local"
            value={value.predicted_discharge_at ?? ""}
            onChange={(e) => onChange({ predicted_discharge_at: e.target.value || null })}
          />
        </div>
        <div className="space-y-1">
          <Label>Predicted step-down</Label>
          <Select
            value={value.predicted_step_down ?? "none"}
            onValueChange={(v) =>
              onChange({
                predicted_step_down:
                  v === "none" ? null : (v as OccupancyFormValue["predicted_step_down"]),
              })
            }
          >
            <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">—</SelectItem>
              <SelectItem value="ward">Ward</SelectItem>
              <SelectItem value="hdu">HDU</SelectItem>
              <SelectItem value="home">Home</SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="notes">Notes</Label>
        <Textarea
          id="notes"
          rows={2}
          value={value.notes ?? ""}
          onChange={(e) => onChange({ notes: e.target.value || null })}
          maxLength={2000}
        />
      </div>
    </div>
  );
}

export function AdmitDialog({
  open,
  bed,
  onOpenChange,
  onSubmit,
  saving,
  initial,
  sourceLabel,
}: {
  open: boolean;
  bed: Bed | null;
  onOpenChange: (v: boolean) => void;
  onSubmit: (v: OccupancyFormValue & { admitted_at: string }) => void;
  saving?: boolean;
  initial?: Partial<OccupancyFormValue>;
  sourceLabel?: string;
}) {
  const [value, setValue] = useState<OccupancyFormValue>({ ...emptyValue(), ...(initial ?? {}) });
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (v) setValue({ ...emptyValue(), ...(initial ?? {}) });
      }}
    >
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Admit to {bed?.code}</DialogTitle>
          <DialogDescription>
            {sourceLabel ? `Prefilled from ${sourceLabel}. ` : ""}Record who now occupies this bed.
          </DialogDescription>
        </DialogHeader>
        <OccupancyForm value={value} onChange={(p) => setValue((v) => ({ ...v, ...p }))} />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button
            onClick={() =>
              onSubmit({ ...value, admitted_at: new Date().toISOString() })
            }
            disabled={saving}
          >
            {saving ? "Admitting…" : "Admit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


export function EditOccupancyDialog({
  open,
  occupancy,
  bedCode,
  onOpenChange,
  onSave,
  onDischarge,
  onMove,
  saving,
  extraActions,
}: {
  open: boolean;
  occupancy: Occ | null;
  bedCode: string;
  onOpenChange: (v: boolean) => void;
  onSave: (v: OccupancyFormValue) => void;
  onDischarge: () => void;
  onMove: () => void;
  saving?: boolean;
  extraActions?: ReactNode;
}) {
  const [value, setValue] = useState<OccupancyFormValue>(emptyValue());
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (v && occupancy) setValue(fromOcc(occupancy));
      }}
    >
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{bedCode} — {occupancy?.patient_initials || "Patient"}</DialogTitle>
          <DialogDescription>Update clinical flags and discharge planning.</DialogDescription>
        </DialogHeader>
        <OccupancyForm value={value} onChange={(p) => setValue((v) => ({ ...v, ...p }))} />
        <DialogFooter className="flex flex-wrap gap-2 justify-between sm:justify-end">
          <div className="flex gap-2 mr-auto">
            <Button variant="outline" size="sm" onClick={onMove} disabled={saving}>Move bed…</Button>
            <Button variant="destructive" size="sm" onClick={onDischarge} disabled={saving}>Discharge</Button>
            {extraActions}
          </div>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={() => onSave(value)} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MoveDialog({
  open,
  beds,
  currentBedId,
  liveBedIds,
  onOpenChange,
  onConfirm,
  saving,
}: {
  open: boolean;
  beds: Bed[];
  currentBedId: string;
  liveBedIds: Set<string>;
  onOpenChange: (v: boolean) => void;
  onConfirm: (new_bed_id: string) => void;
  saving?: boolean;
}) {
  const [target, setTarget] = useState<string>("");
  const options = beds.filter((b) => b.id !== currentBedId && !liveBedIds.has(b.id));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move to another bed</DialogTitle>
          <DialogDescription>Only free beds are listed.</DialogDescription>
        </DialogHeader>
        <Select value={target} onValueChange={setTarget}>
          <SelectTrigger><SelectValue placeholder="Choose bed" /></SelectTrigger>
          <SelectContent>
            {options.map((b) => (
              <SelectItem key={b.id} value={b.id}>{b.code} ({b.unit.toUpperCase()})</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={() => target && onConfirm(target)} disabled={!target || saving}>
            {saving ? "Moving…" : "Move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
