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

type AuthorInfo = { full_name: string | null; job_title: string | null };

export function TransfersPanel({
  transfers,
  authors = {},
  liveOccupancyIds,
  onCreate,
  onAdvance,
  onCancel,
  saving,
}: {
  transfers: Transfer[];
  authors?: Record<string, AuthorInfo>;
  liveOccupancyIds?: Set<string>;
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
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
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
  const authorLabel = (id: string | null): string => {
    if (!id) return "system";
    const a = authors[id];
    if (!a) return "unknown";
    return a.full_name?.trim() || "unknown";
  };

  // Group transfers so duplicates/overlaps (same occupancy, or same
  // destination+kind when no occupancy is linked) collapse to a single card
  // showing the latest state, with earlier rows kept accessible as
  // "superseded" so a user can cancel them.
  const groups = (() => {
    const map = new Map<string, Transfer[]>();
    for (const t of transfers) {
      const key = t.occupancy_id
        ? `occ:${t.occupancy_id}`
        : `dest:${t.destination_hospital.trim().toLowerCase()}|${t.kind}`;
      const arr = map.get(key) ?? [];
      arr.push(t);
      map.set(key, arr);
    }
    return Array.from(map.entries()).map(([key, arr]) => {
      const sorted = [...arr].sort(
        (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      );
      return { key, primary: sorted[0], superseded: sorted.slice(1) };
    });
  })();

  const totalOpen = transfers.length;
  const supersededTotal = groups.reduce((n, g) => n + g.superseded.length, 0);

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-sm flex items-center gap-2">
          <ArrowRightLeft className="w-4 h-4" aria-hidden="true" />
          Transfers out ({totalOpen})
          {supersededTotal > 0 && (
            <Badge variant="secondary" className="text-[10px] font-normal">
              {supersededTotal} duplicate{supersededTotal === 1 ? "" : "s"}
            </Badge>
          )}
        </h3>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <Plus className="w-3.5 h-3.5 mr-1" />Add
        </Button>
      </div>
      {groups.length === 0 && (
        <p className="text-xs text-muted-foreground">No open transfers.</p>
      )}
      <ul className="space-y-2">
        {groups.map(({ key, primary: t, superseded }) => {
          const next = nextStatus(t.status);
          const createdBy = authorLabel(t.created_by);
          const updatedBy = authorLabel(t.updated_by);
          const createdAgo = formatDistanceToNowStrict(new Date(t.created_at), { addSuffix: true });
          const updatedAgo = formatDistanceToNowStrict(new Date(t.updated_at), { addSuffix: true });
          const wasEdited =
            t.updated_at !== t.created_at || (t.updated_by && t.updated_by !== t.created_by);
          const staleOccupancy =
            !!t.occupancy_id && liveOccupancyIds !== undefined && !liveOccupancyIds.has(t.occupancy_id);
          const isExpanded = !!expandedGroups[key];
          return (
            <li key={key} className="border rounded p-2 text-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium truncate">{t.destination_hospital}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {t.kind} · {t.destination_specialty ?? "—"}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <Badge variant="outline" className="text-[10px]">{STATUS_LABEL[t.status]}</Badge>
                  {staleOccupancy && (
                    <Badge variant="destructive" className="text-[10px]">Patient no longer admitted</Badge>
                  )}
                </div>
              </div>
              <div
                className="mt-1.5 text-[11px] text-muted-foreground leading-snug"
                title={`Created ${new Date(t.created_at).toLocaleString()}${wasEdited ? ` · Updated ${new Date(t.updated_at).toLocaleString()}` : ""}`}
              >
                <div>Created by {createdBy} · {createdAgo}</div>
                {wasEdited && (
                  <div>Updated by {updatedBy} · {updatedAgo}</div>
                )}
              </div>
              <div className="flex gap-2 mt-2 flex-wrap">
                {next && !staleOccupancy && (
                  <Button size="sm" variant="outline" disabled={saving} onClick={() => onAdvance(t.id, next)}>
                    → {STATUS_LABEL[next]}
                  </Button>
                )}
                <Button size="sm" variant="ghost" disabled={saving} onClick={() => onCancel(t.id)}>
                  Cancel
                </Button>
                {superseded.length > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setExpandedGroups((s) => ({ ...s, [key]: !s[key] }))
                    }
                  >
                    {isExpanded ? "Hide" : "Show"} {superseded.length} earlier
                  </Button>
                )}
              </div>
              {superseded.length > 0 && isExpanded && (
                <ul className="mt-2 space-y-1.5 border-t pt-2">
                  {superseded.map((s) => (
                    <li
                      key={s.id}
                      className="flex items-start justify-between gap-2 text-xs text-muted-foreground"
                    >
                      <div className="min-w-0">
                        <div className="truncate">
                          <Badge variant="outline" className="text-[10px] mr-1.5">
                            {STATUS_LABEL[s.status]}
                          </Badge>
                          Superseded · created by {authorLabel(s.created_by)} ·{" "}
                          {formatDistanceToNowStrict(new Date(s.created_at), { addSuffix: true })}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11px]"
                        disabled={saving}
                        onClick={() => onCancel(s.id)}
                      >
                        Cancel
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
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
