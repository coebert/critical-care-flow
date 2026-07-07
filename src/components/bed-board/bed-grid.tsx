import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Activity,
  Bed as BedIcon,
  Droplets,
  Plus,
  ShieldAlert,
  Stethoscope,
  Wind,
} from "lucide-react";
import type { Database } from "@/integrations/supabase/types";
import { dayOfStay } from "@/lib/bed-capacity";
import { formatDistanceToNowStrict } from "date-fns";

type Bed = Database["public"]["Tables"]["beds"]["Row"];
type Occ = Database["public"]["Tables"]["bed_occupancies"]["Row"];

const LEVEL_TONE: Record<number, string> = {
  1: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/30",
  2: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
  3: "bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/30",
};

const ISOLATION_LABEL: Record<string, string> = {
  contact: "Contact",
  droplet: "Droplet",
  airborne: "Airborne",
};

function OrganSupportIcons({ o }: { o: Occ }) {
  const items: { key: string; label: string; icon: React.ReactNode }[] = [];
  if (o.ventilated) items.push({ key: "vent", label: "Ventilated", icon: <Wind className="w-3.5 h-3.5" /> });
  if (o.nippv_cpap) items.push({ key: "niv", label: "NIV/CPAP", icon: <Wind className="w-3.5 h-3.5" /> });
  if (o.hfno) items.push({ key: "hfno", label: "HFNO", icon: <Wind className="w-3.5 h-3.5" /> });
  if (o.vasopressors) items.push({ key: "vaso", label: "Vasopressors", icon: <Activity className="w-3.5 h-3.5" /> });
  if (o.renal_replacement) items.push({ key: "rrt", label: "RRT", icon: <Droplets className="w-3.5 h-3.5" /> });
  if (o.tracheostomy) items.push({ key: "trach", label: "Tracheostomy", icon: <Stethoscope className="w-3.5 h-3.5" /> });
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-2">
      {items.map((i) => (
        <span
          key={i.key}
          title={i.label}
          aria-label={i.label}
          className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground border"
        >
          {i.icon}
          {i.label}
        </span>
      ))}
    </div>
  );
}

export function BedCard({
  bed,
  occupancy,
  onEmptyClick,
  onOccupiedClick,
}: {
  bed: Bed;
  occupancy: Occ | undefined;
  onEmptyClick: (bed: Bed) => void;
  onOccupiedClick: (occ: Occ) => void;
}) {
  if (!occupancy) {
    return (
      <Card
        className="p-3 flex flex-col justify-between min-h-28 border-dashed hover:bg-accent/40 cursor-pointer transition"
        onClick={() => onEmptyClick(bed)}
        role="button"
        tabIndex={0}
        aria-label={`Empty bed ${bed.code} — click to admit`}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onEmptyClick(bed)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
            <BedIcon className="w-4 h-4" aria-hidden="true" />
            {bed.code}
          </div>
          {bed.is_side_room && (
            <Badge variant="outline" className="text-[10px]">Side room</Badge>
          )}
        </div>
        <div className="flex items-center justify-center text-muted-foreground text-sm">
          <Plus className="w-4 h-4 mr-1" /> Admit
        </div>
      </Card>
    );
  }
  const predicted = occupancy.predicted_discharge_at
    ? formatDistanceToNowStrict(new Date(occupancy.predicted_discharge_at), { addSuffix: true })
    : null;
  return (
    <Card
      className="p-3 min-h-28 hover:bg-accent/40 cursor-pointer transition"
      onClick={() => onOccupiedClick(occupancy)}
      role="button"
      tabIndex={0}
      aria-label={`Bed ${bed.code} — click to edit`}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOccupiedClick(occupancy)}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          <BedIcon className="w-4 h-4" aria-hidden="true" />
          {bed.code}
        </div>
        <Badge variant="outline" className={`text-[10px] ${LEVEL_TONE[occupancy.level] ?? ""}`}>
          L{occupancy.level}
        </Badge>
      </div>
      <div className="mt-1 text-sm truncate">
        {occupancy.patient_initials || "—"}{" "}
        <span className="text-xs text-muted-foreground">
          {occupancy.hospital_number ? `· ${occupancy.hospital_number}` : ""}
        </span>
      </div>
      <div className="text-xs text-muted-foreground truncate">
        {occupancy.admitting_consultant || "—"} · Day {dayOfStay(occupancy.admitted_at)}
      </div>
      <OrganSupportIcons o={occupancy} />
      <div className="mt-2 flex flex-wrap gap-1 items-center">
        {occupancy.isolation !== "none" && (
          <Badge variant="outline" className="text-[10px] gap-1">
            <ShieldAlert className="w-3 h-3" aria-hidden="true" />
            {ISOLATION_LABEL[occupancy.isolation] ?? occupancy.isolation}
          </Badge>
        )}
        {predicted && (
          <span className="text-[11px] text-muted-foreground">
            D/C {predicted}
          </span>
        )}
      </div>
    </Card>
  );
}

export function BedGrid({
  beds,
  occupancies,
  onEmptyClick,
  onOccupiedClick,
}: {
  beds: Bed[];
  occupancies: Occ[];
  onEmptyClick: (bed: Bed) => void;
  onOccupiedClick: (occ: Occ) => void;
}) {
  const liveByBed = new Map<string, Occ>();
  for (const o of occupancies) if (!o.discharged_at) liveByBed.set(o.bed_id, o);
  const icu = beds.filter((b) => b.unit === "icu");
  const hdu = beds.filter((b) => b.unit === "hdu");
  return (
    <div className="space-y-6">
      {[
        { label: "ICU", list: icu },
        { label: "HDU", list: hdu },
      ].map(({ label, list }) => (
        <section key={label}>
          <h2 className="text-sm font-semibold text-muted-foreground mb-2">{label}</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {list.map((b) => (
              <BedCard
                key={b.id}
                bed={b}
                occupancy={liveByBed.get(b.id)}
                onEmptyClick={onEmptyClick}
                onOccupiedClick={onOccupiedClick}
              />
            ))}
            {list.length === 0 && (
              <div className="col-span-full text-sm text-muted-foreground">
                No {label} beds configured. Admins can add beds in the register.
              </div>
            )}
          </div>
        </section>
      ))}
      <div className="text-xs text-muted-foreground">
        <Button variant="link" size="sm" className="h-auto p-0" asChild>
          <span />
        </Button>
      </div>
    </div>
  );
}
