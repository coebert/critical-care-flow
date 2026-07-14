import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Bed as BedIcon,
  Biohazard,
  Loader2,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Swords,
  UserRound,
} from "lucide-react";
import { formatDistanceToNowStrict, formatDistanceStrict } from "date-fns";
import { toast } from "sonner";
import {
  getPartnerBedBoard,
  updatePartnerPatient,
  type PartnerBedSlot,
  type PartnerOccupant,
  type UpdatePartnerPatientInput,
} from "@/lib/partner-bed-board.functions";
import {
  getPatientAcuity,
  setPatientAcuity,
  type AcuityLevel,
} from "@/lib/patient-acuity.functions";
import { getPatientAirways } from "@/lib/patient-airway.functions";
import {
  getPatientIsolations,
  type PatientIsolationEntry,
} from "@/lib/patient-infection.functions";
import {
  listViolenceRisk,
  setViolenceRisk,
} from "@/lib/patient-violence-risk.functions";
import {
  listWardableStatus,
  setWardableStatus,
  dischargePatient,
  clearDischarge,
  type WardableStatus,
} from "@/lib/wardable-status.functions";
import { prefillPartnerHandoverFromReferral } from "@/lib/partner-handover-prefill.functions";
import { toInitials } from "@/lib/patient-initials";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";


const QK = ["partner-bed-board"] as const;
const AQK = ["patient-acuity"] as const;

import { LEVEL_TONE, LEVEL_LABEL, computeUnitAcuity } from "@/lib/acuity";
import { NurseCapacityPanel } from "@/components/bed-board/nurse-capacity-panel";
import type { Occupancy } from "@/lib/bed-capacity";

export const Route = createFileRoute("/_authenticated/bed-board")({
  head: () => ({
    meta: [
      { title: "Bed board — SDH Critical Care" },
      {
        name: "description",
        content:
          "Live ICU/HDU bed board sourced from the ICU Handover Hub.",
      },
    ],
  }),
  // Preserved for backwards compatibility with callers that still deep-link
  // referral/postop context or nurse-capacity alerts. This page no longer
  // owns the admit flow (writes go through ICU Handover Hub), so we display
  // a lightweight breadcrumb banner instead of a prefilled dialog.
  validateSearch: (s: Record<string, unknown>) => {
    const str = (v: unknown): string | undefined =>
      typeof v === "string" && v.trim().length ? v.trim() : undefined;
    const parseShift = (v: unknown): "day" | "night" | undefined => {
      const t = str(v)?.toLowerCase();
      return t === "day" || t === "night" ? t : undefined;
    };
    const parseLevel = (v: unknown): 1 | 2 | 3 | undefined => {
      const t = str(v);
      if (!t) return undefined;
      const n = Number(t);
      if (!Number.isFinite(n) || Math.trunc(n) !== n) return undefined;
      return n === 1 || n === 2 || n === 3 ? (n as 1 | 2 | 3) : undefined;
    };
    return {
      source_referral_id: str(s.source_referral_id),
      source_postop_booking_id: str(s.source_postop_booking_id),
      hospital_number: str(s.hospital_number),
      patient_initials: str(s.patient_initials),
      admitting_consultant: str(s.admitting_consultant),
      level: parseLevel(s.level),
      source_label: str(s.source_label),
      focus_shift: parseShift(s.focus_shift),
      focus_level: parseLevel(s.focus_level),
    };
  },
  component: BedBoardPage,
});

function formatUpdated(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return "—";
  return formatDistanceToNowStrict(d, { addSuffix: true });
}

function dayOfStay(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!isFinite(t)) return null;
  return Math.max(1, Math.floor((Date.now() - t) / 86_400_000) + 1);
}

function WardableToggle({
  wardable,
  wardableAt,
  pending,
  onToggle,
}: {
  wardable: boolean;
  wardableAt: string | null;
  pending: boolean;
  onToggle: () => void;
}) {
  // Live-updating "since" label — tick once a minute while marked wardable.
  const [, force] = useState(0);
  useEffect(() => {
    if (!wardable || !wardableAt) return;
    const id = setInterval(() => force((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [wardable, wardableAt]);
  const elapsed =
    wardable && wardableAt
      ? formatDistanceToNowStrict(new Date(wardableAt))
      : null;
  const title = wardable && wardableAt
    ? `Wardable since ${new Date(wardableAt).toLocaleString()} — click to clear`
    : "Mark ready for discharge to the ward";
  return (
    <button
      type="button"
      aria-pressed={wardable}
      onClick={(e) => {
        e.stopPropagation();
        if (!pending) onToggle();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDragStart={(e) => e.preventDefault()}
      draggable={false}
      disabled={pending}
      title={title}
      className={
        "mt-1 inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition disabled:opacity-60 " +
        (wardable
          ? "bg-emerald-500/15 text-emerald-800 border-emerald-500/40 dark:text-emerald-300 dark:border-emerald-400/40 hover:bg-emerald-500/25"
          : "bg-transparent text-muted-foreground border-dashed hover:bg-accent hover:text-foreground")
      }
    >
      <span aria-hidden="true">{wardable ? "✓" : "○"}</span>
      <span>
        {wardable
          ? elapsed
            ? `Wardable · ${elapsed}`
            : "Wardable"
          : "Wardable"}
      </span>
    </button>
  );
}

function DischargeControl({
  wardable,
  wardableAt,
  dischargedAt,
  pending,
  onDischarge,
  onClear,
}: {
  wardable: boolean;
  wardableAt: string | null;
  dischargedAt: string | null;
  pending: boolean;
  onDischarge: () => void;
  onClear: () => void;
}) {
  const [, force] = useState(0);
  useEffect(() => {
    // Tick while wardable and not yet discharged so the elapsed timer
    // updates in the corner of the board.
    if (dischargedAt || !wardable || !wardableAt) return;
    const id = setInterval(() => force((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [wardable, wardableAt, dischargedAt]);

  if (dischargedAt) {
    const window =
      wardableAt
        ? formatDistanceStrict(new Date(wardableAt), new Date(dischargedAt))
        : null;
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (!pending) onClear();
        }}
        onKeyDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        disabled={pending}
        draggable={false}
        title={`Discharged ${new Date(dischargedAt).toLocaleString()}${
          window ? ` — ${window} from wardable` : ""
        }. Click to undo.`}
        className="mt-1 inline-flex items-center gap-1 rounded border border-sky-500/40 bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-800 dark:text-sky-300 hover:bg-sky-500/25 transition disabled:opacity-60"
      >
        <span aria-hidden="true">✓</span>
        <span>Discharged{window ? ` · ${window}` : ""}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (!pending) onDischarge();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      disabled={pending}
      draggable={false}
      title={
        wardable && wardableAt
          ? `Record discharge — will log time from wardable (${new Date(wardableAt).toLocaleString()})`
          : "Record discharge from critical care"
      }
      className="mt-1 inline-flex items-center gap-1 rounded border border-dashed px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground hover:bg-accent hover:text-foreground transition disabled:opacity-60"
    >
      <span aria-hidden="true">→</span>
      <span>Discharge</span>
    </button>
  );
}

function BedCard({
  slot,
  level,
  oneToOne,
  hasTracheostomy,
  isolation,
  isolationReason,
  violenceRisk,
  violencePending,
  onToggleViolenceRisk,
  wardable,
  wardableAt,
  dischargedAt,
  wardablePending,
  dischargePending,
  onToggleWardable,
  onDischarge,
  onOccupiedClick,
  onMove,
  isDragTarget,
  onDragStateChange,
}: {
  slot: PartnerBedSlot;
  level: AcuityLevel | undefined;
  oneToOne: boolean;
  hasTracheostomy: boolean;
  isolation: "contact" | "droplet" | "airborne" | null;
  isolationReason: string | null;
  violenceRisk: boolean;
  violencePending: boolean;
  onToggleViolenceRisk: (occupantId: string, next: boolean) => void;
  wardable: boolean;
  wardableAt: string | null;
  dischargedAt: string | null;
  wardablePending: boolean;
  dischargePending: boolean;
  onToggleWardable: (occupantId: string, next: boolean) => void;
  onDischarge: (occupantId: string, undo: boolean) => void;
  onOccupiedClick: (o: PartnerOccupant) => void;
  onMove: (
    occupantId: string,
    expected_updated_at: string | null,
    sourceBed: string | null,
    targetBed: string,
  ) => void;
  isDragTarget: boolean;
  onDragStateChange: (dragging: boolean) => void;
}) {

  const occ = slot.occupant;
  const [dragOver, setDragOver] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    if (!isDragTarget) return;
    // Only accept our own payload type.
    if (!e.dataTransfer.types.includes("application/x-bed-move")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!dragOver) setDragOver(true);
  };
  const handleDragLeave = () => setDragOver(false);
  const handleDrop = (e: React.DragEvent) => {
    if (!isDragTarget) return;
    e.preventDefault();
    setDragOver(false);
    const raw = e.dataTransfer.getData("application/x-bed-move");
    if (!raw) return;
    try {
      const payload = JSON.parse(raw) as {
        occupantId: string;
        updatedAt: string | null;
        sourceBed: string | null;
      };
      if (!payload.occupantId) return;
      if (payload.sourceBed === slot.bed) return;
      onMove(payload.occupantId, payload.updatedAt, payload.sourceBed, slot.bed);
    } catch {
      /* ignore malformed payload */
    }
  };

  if (!slot.occupied || !occ) {
    return (
      <Card
        className={`p-3 flex flex-col justify-between min-h-24 border-dashed bg-muted/20 transition ${
          dragOver && isDragTarget ? "ring-2 ring-primary bg-primary/10" : ""
        }`}
        aria-label={`Empty bed ${slot.bed}${isDragTarget ? " — drop to move patient here" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
            <BedIcon className="w-4 h-4" aria-hidden="true" />
            {slot.bed}
          </div>
          {slot.is_side_room && (
            <Badge variant="outline" className="text-[10px]">
              Side room
            </Badge>
          )}
        </div>
        <div className="text-center text-xs text-muted-foreground">
          {dragOver && isDragTarget ? "Drop to move here" : "Empty"}
        </div>
      </Card>
    );
  }
  const day = dayOfStay(occ.admission_date);
  return (
    <Card
      className="p-3 min-h-24 hover:bg-accent/40 cursor-grab active:cursor-grabbing transition"
      onClick={() => onOccupiedClick(occ)}
      role="button"
      tabIndex={0}
      aria-label={`Bed ${slot.bed} — ${occ.full_name ?? "occupied"} (drag to move to another bed)`}
      onKeyDown={(e) =>
        (e.key === "Enter" || e.key === " ") && onOccupiedClick(occ)
      }
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(
          "application/x-bed-move",
          JSON.stringify({
            occupantId: occ.id,
            updatedAt: occ.updated_at ?? null,
            sourceBed: slot.bed,
          }),
        );
        onDragStateChange(true);
      }}
      onDragEnd={() => onDragStateChange(false)}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          <BedIcon className="w-4 h-4" aria-hidden="true" />
          {slot.bed}
        </div>
        <div className="flex items-center gap-1">
          {level != null && (
            <Badge
              variant="outline"
              className={`text-[10px] ${LEVEL_TONE[level]}`}
              title={LEVEL_LABEL[level]}
              aria-label={LEVEL_LABEL[level]}
            >
              L{level}
            </Badge>
          )}
          {slot.is_side_room && (
            <Badge variant="outline" className="text-[10px]">
              Side room
            </Badge>
          )}
          {oneToOne && (
            <Badge
              variant="outline"
              className="text-[10px] gap-1 bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/30"
              title="Requires 1:1 nursing"
            >
              1:1
            </Badge>
          )}
          {occ.tep_in_place && (
            <Badge
              variant="outline"
              className="text-[10px] gap-1"
              title="Treatment Escalation Plan in place"
            >
              <ShieldCheck className="w-3 h-3" aria-hidden="true" />
              TEP
            </Badge>
          )}
          {hasTracheostomy && (
            <Badge
              variant="outline"
              className="text-[10px] gap-1 bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/30"
              title="Tracheostomy in situ"
              aria-label="Tracheostomy in situ"
            >
              <Stethoscope className="w-3 h-3" aria-hidden="true" />
              Trache
            </Badge>
          )}
          {isolation && (
            <Badge
              variant="outline"
              className="text-[10px] gap-1 bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30"
              title={`Isolation: ${isolation}${isolationReason ? ` — ${isolationReason}` : ""}`}
              aria-label={`Isolation required: ${isolation}${isolationReason ? `, ${isolationReason}` : ""}`}
            >
              <Biohazard className="w-3 h-3" aria-hidden="true" />
              {isolation === "contact"
                ? "Contact"
                : isolation === "droplet"
                  ? "Droplet"
                  : "Airborne"}
            </Badge>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (!violencePending) onToggleViolenceRisk(occ.id, !violenceRisk);
            }}
            disabled={violencePending}
            title={
              violenceRisk
                ? "Violence risk flagged — click to clear"
                : "Flag as potentially violent or aggressive"
            }
            aria-pressed={violenceRisk}
            aria-label={
              violenceRisk
                ? "Clear violence-risk flag"
                : "Flag patient as potentially violent or aggressive"
            }
            className="focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
          >
            <Badge
              variant="outline"
              className={`text-[10px] gap-1 cursor-pointer transition ${
                violenceRisk
                  ? "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/40"
                  : "bg-transparent text-muted-foreground border-dashed opacity-60 hover:opacity-100"
              } ${violencePending ? "opacity-50" : ""}`}
            >
              <Swords className="w-3 h-3" aria-hidden="true" />
              {violenceRisk ? "Violence risk" : "Violence?"}
            </Badge>
          </button>



        </div>
      </div>
      <div className="mt-1 text-sm truncate font-medium">
        {occ.full_name || "—"}
      </div>
      <div className="text-xs text-muted-foreground truncate">
        {occ.hospital_number ? `${occ.hospital_number}` : "—"}
        {occ.age != null ? ` · ${occ.age}y` : ""}
        {day != null ? ` · Day ${day}` : ""}
      </div>
      {occ.dnacpr_decision === true && (
        <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-400 truncate">
          DNACPR in place
          {occ.dnacpr_details ? ` — ${occ.dnacpr_details}` : ""}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <WardableToggle
          wardable={wardable}
          wardableAt={wardableAt}
          pending={wardablePending}
          onToggle={() => onToggleWardable(occ.id, !wardable)}
        />
        <DischargeControl
          wardable={wardable}
          wardableAt={wardableAt}
          dischargedAt={dischargedAt}
          pending={dischargePending}
          onDischarge={() => onDischarge(occ.id, false)}
          onClear={() => onDischarge(occ.id, true)}
        />
      </div>



    </Card>
  );
}


function StatBlock({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "ok" | "warn" | "bad" | "muted";
}) {
  const toneClass =
    tone === "bad"
      ? "bg-destructive/10 text-destructive border-destructive/30"
      : tone === "warn"
        ? "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30"
        : tone === "ok"
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30"
          : "bg-muted text-muted-foreground";
  return (
    <div
      className={`flex items-center gap-2 rounded-md border px-3 py-1.5 ${toneClass}`}
    >
      <div className="text-sm font-semibold">{label}</div>
      <div className="text-sm tabular-nums">{value}</div>
    </div>
  );
}

function EmptyStateCard({
  title,
  body,
  tone = "muted",
}: {
  title: string;
  body: string;
  tone?: "muted" | "ok";
}) {
  const cls =
    tone === "ok"
      ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-800 dark:text-emerald-300"
      : "border-dashed bg-muted/20 text-muted-foreground";
  return (
    <Card className={`p-3 text-sm ${cls}`}>
      <div className="font-medium">{title}</div>
      <div className="text-xs mt-1 opacity-90">{body}</div>
    </Card>
  );
}

function BedBoardPage() {

  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const fetchBoard = useServerFn(getPartnerBedBoard);
  const fetchAcuity = useServerFn(getPatientAcuity);
  const fetchAirways = useServerFn(getPatientAirways);
  const fetchIsolations = useServerFn(getPatientIsolations);
  const fetchViolence = useServerFn(listViolenceRisk);
  const writeViolence = useServerFn(setViolenceRisk);
  const qc = useQueryClient();
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: QK,
    queryFn: () => fetchBoard(),
    staleTime: 5_000,
    // Partner data is a live snapshot pulled on demand; poll and refetch on
    // focus to stay close to real time without hammering the partner.
    refetchInterval: 20_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const { data: acuityRows, refetch: refetchAcuity } = useQuery({
    queryKey: AQK,
    queryFn: () => fetchAcuity(),
    staleTime: 5_000,
    refetchInterval: 30_000,
  });
  type AcuityInfo = { level: AcuityLevel; one_to_one: boolean };
  const acuityMap = useMemo(() => {
    const m = new Map<string, AcuityInfo>();
    for (const r of acuityRows ?? []) {
      m.set(r.partner_patient_id, {
        level: r.level as AcuityLevel,
        one_to_one: r.one_to_one === true,
      });
    }
    return m;
  }, [acuityRows]);

  // Tracheostomy indicator source: partner-mirrored `patients.airway_type`.
  // Pulled by the scheduled bridge sync — we just look it up per occupant.
  const { data: airwayRows } = useQuery({
    queryKey: ["patient-airways"],
    queryFn: () => fetchAirways(),
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
  const tracheostomySet = useMemo(() => {
    const s = new Set<string>();
    for (const r of airwayRows ?? []) {
      if ((r.airway_type ?? "").toLowerCase() === "tracheostomy") {
        s.add(r.partner_patient_id);
      }
    }
    return s;
  }, [airwayRows]);

  // Isolation / infection indicator source: local `bed_occupancies.isolation`.
  // Any value other than `none` means the patient needs isolation.
  const { data: isolationRows } = useQuery({
    queryKey: ["patient-isolations"],
    queryFn: () => fetchIsolations(),
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
  const isolationMap = useMemo(() => {
    const m = new Map<string, PatientIsolationEntry>();
    for (const r of isolationRows ?? []) {
      m.set(r.partner_patient_id, r);
    }
    return m;
  }, [isolationRows]);
  // Violence-risk flag (user-toggleable, local source of truth).
  const { data: violenceRows } = useQuery({
    queryKey: ["patient-violence-risk"],
    queryFn: () => fetchViolence(),
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
  const violenceSet = useMemo(() => {
    const s = new Set<string>();
    for (const r of violenceRows ?? []) {
      if (r.violence_risk) s.add(r.partner_patient_id);
    }
    return s;
  }, [violenceRows]);

  const violenceMutation = useMutation({
    mutationFn: (v: { partner_patient_id: string; violence_risk: boolean }) =>
      writeViolence({ data: v }),
    onSuccess: (_r, vars) => {
      toast.success(
        vars.violence_risk
          ? "Flagged as potentially violent / aggressive"
          : "Violence-risk flag cleared",
      );
      qc.invalidateQueries({ queryKey: ["patient-violence-risk"] });
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Could not update flag"),
  });
  const handleToggleViolence = (occupantId: string, next: boolean) => {
    violenceMutation.mutate({ partner_patient_id: occupantId, violence_risk: next });
  };



  const [selected, setSelected] = useState<PartnerOccupant | null>(null);
  const [dragging, setDragging] = useState(false);

  const moveBed = useServerFn(updatePartnerPatient);
  const moveMutation = useMutation({
    mutationFn: (input: {
      id: string;
      expected_updated_at: string | null;
      bed: string;
    }) => moveBed({ data: input }),
    onSuccess: (result, vars) => {
      if (result.ok) {
        toast.success(`Moved patient to bed ${vars.bed}`);
        refetch();
      } else if (result.status === 409) {
        toast.warning("Bed changed elsewhere — refreshing");
        refetch();
      } else {
        toast.error(result.error || "Could not move patient");
      }
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Could not move patient"),
  });

  const handleMove = (
    occupantId: string,
    expected_updated_at: string | null,
    _sourceBed: string | null,
    targetBed: string,
  ) => {
    moveMutation.mutate({ id: occupantId, expected_updated_at, bed: targetBed });
  };

  // ---- Wardable status (local source of truth) ----
  const fetchWardable = useServerFn(listWardableStatus);
  const wardableQuery = useQuery({
    queryKey: ["patient-wardable-status"],
    queryFn: () => fetchWardable(),
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
  const wardableMap = useMemo(() => {
    const m = new Map<string, WardableStatus>();
    for (const r of wardableQuery.data ?? []) m.set(r.partner_patient_id, r);
    return m;
  }, [wardableQuery.data]);

  const setWardable = useServerFn(setWardableStatus);
  const wardableMutation = useMutation({
    mutationFn: (input: { partner_patient_id: string; wardable: boolean }) =>
      setWardable({ data: input }),
    onMutate: async (input) => {
      // Optimistic update so the timer starts ticking the instant the user
      // clicks — the round-trip to the partner shouldn't delay the stamp.
      await qc.cancelQueries({ queryKey: ["patient-wardable-status"] });
      const previous = qc.getQueryData<WardableStatus[]>([
        "patient-wardable-status",
      ]);
      qc.setQueryData<WardableStatus[]>(
        ["patient-wardable-status"],
        (rows) => {
          const list = rows ? [...rows] : [];
          const idx = list.findIndex(
            (r) => r.partner_patient_id === input.partner_patient_id,
          );
          const existing = idx >= 0 ? list[idx] : undefined;
          const now = new Date().toISOString();
          const next: WardableStatus = {
            partner_patient_id: input.partner_patient_id,
            wardable: input.wardable,
            wardable_at: input.wardable
              ? existing?.wardable && existing.wardable_at
                ? existing.wardable_at
                : now
              : null,
            discharged_at: null,
            updated_at: now,
          };
          if (idx >= 0) list[idx] = next;
          else list.push(next);
          return list;
        },
      );
      return { previous };
    },
    onError: (err, _input, ctx) => {
      if (ctx?.previous) {
        qc.setQueryData(["patient-wardable-status"], ctx.previous);
      }
      toast.error(err instanceof Error ? err.message : "Could not update wardable status");
    },
    onSettled: () => {
      wardableQuery.refetch();
    },
  });

  const handleToggleWardable = (occupantId: string, next: boolean) => {
    wardableMutation.mutate({ partner_patient_id: occupantId, wardable: next });
  };

  // ---- Discharge (records elapsed time from wardable_at → discharged_at) ----
  const dischargeFn = useServerFn(dischargePatient);
  const clearDischargeFn = useServerFn(clearDischarge);
  const dischargeMutation = useMutation({
    mutationFn: (input: { partner_patient_id: string; undo?: boolean }) =>
      input.undo
        ? clearDischargeFn({ data: { partner_patient_id: input.partner_patient_id } })
        : dischargeFn({ data: { partner_patient_id: input.partner_patient_id } }),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: ["patient-wardable-status"] });
      const previous = qc.getQueryData<WardableStatus[]>([
        "patient-wardable-status",
      ]);
      qc.setQueryData<WardableStatus[]>(
        ["patient-wardable-status"],
        (rows) => {
          const list = rows ? [...rows] : [];
          const idx = list.findIndex(
            (r) => r.partner_patient_id === input.partner_patient_id,
          );
          const now = new Date().toISOString();
          const existing = idx >= 0 ? list[idx] : undefined;
          const next: WardableStatus = {
            partner_patient_id: input.partner_patient_id,
            wardable: existing?.wardable ?? false,
            wardable_at: existing?.wardable_at ?? null,
            discharged_at: input.undo ? null : now,
            updated_at: now,
          };
          if (idx >= 0) list[idx] = next;
          else list.push(next);
          return list;
        },
      );
      return { previous };
    },
    onError: (err, _input, ctx) => {
      if (ctx?.previous) {
        qc.setQueryData(["patient-wardable-status"], ctx.previous);
      }
      toast.error(err instanceof Error ? err.message : "Could not record discharge");
    },
    onSuccess: (_r, input) => {
      toast.success(input.undo ? "Discharge cleared" : "Discharge recorded");
    },
    onSettled: () => {
      wardableQuery.refetch();
    },
  });

  const handleDischarge = (occupantId: string, undo: boolean) => {
    dischargeMutation.mutate({ partner_patient_id: occupantId, undo });
  };




  const arrivedFromSource =
    search.source_referral_id || search.source_postop_booking_id;
  const clearSource = () =>
    navigate({
      search: {
        source_referral_id: undefined,
        source_postop_booking_id: undefined,
        hospital_number: undefined,
        patient_initials: undefined,
        admitting_consultant: undefined,
        level: undefined,
        source_label: undefined,
        focus_shift: search.focus_shift,
        focus_level: search.focus_level,
      },
      replace: true,
    });

  // If we get an ok:false response, surface it as an error banner but keep the
  // prior successful payload rendered so the board doesn't blank out on a
  // transient partner blip.
  const lastOk = data && data.ok ? data : null;
  const partnerError = data && !data.ok ? data.error : null;
  const partnerOutage =
    data && !data.ok && (data.partner_outage === true);

  useEffect(() => {
    // No local Realtime subscription: the partner data is fetched over HTTP,
    // and their DB is not in our Supabase project. The polling above is the
    // only refresh mechanism.
    return () => {
      qc.cancelQueries({ queryKey: QK });
    };
  }, [qc]);

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="mb-4 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Bed board</h1>
          <p className="text-sm text-muted-foreground">
            Live snapshot from ICU Handover Hub
            {lastOk ? (
              <>
                {" "}
                · updated {formatUpdated(lastOk.fetched_at)}
              </>
            ) : null}
            .
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            className="gap-1"
          >
            <RefreshCcw
              className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            Refresh
          </Button>
          <Link
            to="/board"
            className="rounded-md border px-3 py-1.5 hover:bg-accent"
          >
            TV / whiteboard mode
          </Link>
        </div>
      </div>

      {arrivedFromSource && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
          <div>
            Arrived from{" "}
            <span className="font-medium">{search.source_label ?? "referral"}</span>
            {search.patient_initials ? (
              <>
                {" · "}
                <span className="font-mono">{search.patient_initials}</span>
              </>
            ) : null}
            . Admissions are now recorded in{" "}
            <span className="font-medium">ICU Handover Hub</span>; place the
            patient there and the bed will appear here on the next refresh.
          </div>
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
            onClick={clearSource}
          >
            Dismiss
          </button>
        </div>
      )}


      {lastOk && (() => {
        const allOccupants = [
          ...lastOk.bed_board
            .map((b) => b.occupant)
            .filter((o): o is PartnerOccupant => o !== null),
          ...lastOk.unassigned,
        ];
        const levelMap = new Map<string, AcuityLevel>();
        for (const [k, v] of acuityMap) levelMap.set(k, v.level);
        const { counts, unscored, mean } = computeUnitAcuity(
          allOccupants.map((o) => o.id),
          levelMap,
        );
        const oneToOneCount = allOccupants.reduce(
          (n, o) => n + (acuityMap.get(o.id)?.one_to_one ? 1 : 0),
          0,
        );

        return (
          <>
            <div
              className="flex flex-wrap items-center gap-2 mb-3"
              role="status"
              aria-label="Unit capacity"
            >
              <StatBlock label={lastOk.unit} value={lastOk.stats.total_beds} tone="muted" />
              <StatBlock
                label="Occupied"
                value={lastOk.stats.occupied}
                tone={
                  lastOk.stats.available === 0
                    ? "bad"
                    : lastOk.stats.available <= 1
                      ? "warn"
                      : "ok"
                }
              />
              <StatBlock
                label="Free"
                value={lastOk.stats.available}
                tone={
                  lastOk.stats.available === 0
                    ? "bad"
                    : lastOk.stats.available <= 1
                      ? "warn"
                      : "ok"
                }
              />
              {lastOk.stats.unassigned > 0 && (
                <Badge variant="outline" className="gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                  {lastOk.stats.unassigned} unassigned
                </Badge>
              )}
            </div>
            <div
              className="flex flex-wrap items-center gap-2 mb-4"
              role="status"
              aria-label="Unit acuity"
            >
              <div className="text-xs uppercase tracking-wide text-muted-foreground mr-1">
                Acuity
              </div>
              {([0, 1, 2, 3] as const).map((l) => (
                <div
                  key={l}
                  className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm ${LEVEL_TONE[l]}`}
                  title={LEVEL_LABEL[l]}
                >
                  <span className="font-semibold">L{l}</span>
                  <span className="tabular-nums">{counts[l]}</span>
                </div>
              ))}
              <div
                className="flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm bg-muted text-muted-foreground"
                title="Mean level across scored patients"
              >
                <span className="font-semibold">Mean</span>
                <span className="tabular-nums">{mean.toFixed(2)}</span>
              </div>
              {unscored > 0 && (
                <div className="text-xs text-muted-foreground">
                  {unscored} patient{unscored === 1 ? "" : "s"} not yet scored
                </div>
              )}
            </div>
            <NurseCapacityPanel
              occupancies={allOccupants.map<Occupancy>((o) => {
                const a = acuityMap.get(o.id);
                return {
                  id: o.id,
                  bed_id: o.bed ?? o.id,
                  discharged_at: null,
                  predicted_discharge_at: null,
                  level: a?.level ?? 1,
                  one_to_one: a?.one_to_one === true,
                };
              })}
              focusShift={search.focus_shift}
              focusLevel={search.focus_level}
              oneToOneCount={oneToOneCount}
            />

          </>
        );
      })()}

      {partnerError && (
        <div
          className={
            partnerOutage
              ? "mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              : "mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200"
          }
          role="alert"
        >
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="w-4 h-4" aria-hidden="true" />
            {partnerOutage
              ? "ICU Handover Hub is currently unavailable"
              : "Bed board did not refresh"}
          </div>
          <div className="text-xs mt-1 break-words">
            {partnerOutage
              ? "The partner service is down or unreachable. The bed board will resume automatically once it is back online."
              : partnerError}
          </div>
          {lastOk && (
            <div className="text-xs mt-1 text-muted-foreground">
              Showing last successful snapshot from{" "}
              {formatUpdated(lastOk.fetched_at)}.
            </div>
          )}
        </div>
      )}

      {isLoading && !data && (
        <div className="text-sm text-muted-foreground">Loading bed board…</div>
      )}
      {error && !data && (
        <div className="text-sm text-destructive" role="alert">
          Failed to load bed board:{" "}
          {error instanceof Error ? error.message : "unknown"}
        </div>
      )}

      {lastOk && (
        <div className="space-y-6">
          <section>
            <h2 className="text-sm font-semibold text-muted-foreground mb-2">
              {lastOk.unit}
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {lastOk.bed_board.map((slot) => {
                const a = slot.occupant ? acuityMap.get(slot.occupant.id) : undefined;
                const w = slot.occupant ? wardableMap.get(slot.occupant.id) : undefined;
                const pendingId =
                  wardableMutation.isPending &&
                  (wardableMutation.variables as { partner_patient_id?: string } | undefined)
                    ?.partner_patient_id;
                const dischargePendingId =
                  dischargeMutation.isPending &&
                  (dischargeMutation.variables as { partner_patient_id?: string } | undefined)
                    ?.partner_patient_id;
                const violencePendingId =
                  violenceMutation.isPending &&
                  (violenceMutation.variables as { partner_patient_id?: string } | undefined)
                    ?.partner_patient_id;
                return (
                  <BedCard
                    key={slot.bed}
                    slot={slot}
                    level={a?.level}
                    oneToOne={a?.one_to_one === true}
                    hasTracheostomy={
                      slot.occupant?.id != null &&
                      tracheostomySet.has(slot.occupant.id)
                    }
                    violenceRisk={
                      slot.occupant?.id != null &&
                      violenceSet.has(slot.occupant.id)
                    }
                    violencePending={
                      slot.occupant?.id != null &&
                      violencePendingId === slot.occupant.id
                    }
                    onToggleViolenceRisk={handleToggleViolence}
                    isolation={
                      (slot.occupant?.id != null &&
                        isolationMap.get(slot.occupant.id)?.isolation) ||
                      null
                    }
                    isolationReason={
                      (slot.occupant?.id != null &&
                        isolationMap.get(slot.occupant.id)?.isolation_reason) ||
                      null
                    }
                    wardable={w?.wardable === true}
                    wardableAt={w?.wardable_at ?? null}
                    dischargedAt={w?.discharged_at ?? null}
                    wardablePending={
                      slot.occupant?.id != null && pendingId === slot.occupant.id
                    }
                    dischargePending={
                      slot.occupant?.id != null &&
                      dischargePendingId === slot.occupant.id
                    }
                    onToggleWardable={handleToggleWardable}
                    onDischarge={handleDischarge}
                    onOccupiedClick={setSelected}
                    onMove={handleMove}
                    isDragTarget={dragging}
                    onDragStateChange={setDragging}
                  />
                );
              })}

              {lastOk.bed_board.length === 0 && (
                <div className="col-span-full text-sm text-muted-foreground">
                  No beds in the partner roster.
                </div>
              )}
            </div>
          </section>

          {lastOk.unassigned.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-muted-foreground mb-2 flex items-center gap-1">
                <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                Unassigned patients ({lastOk.unassigned.length})
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {lastOk.unassigned.map((occ) => (
                  <Card
                    key={occ.id}
                    className="p-3 hover:bg-accent/40 cursor-pointer transition"
                    onClick={() => setSelected(occ)}
                    role="button"
                    tabIndex={0}
                    aria-label={`Unassigned — ${occ.full_name ?? "patient"}`}
                    onKeyDown={(e) =>
                      (e.key === "Enter" || e.key === " ") && setSelected(occ)
                    }
                  >
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      <UserRound className="w-4 h-4" aria-hidden="true" />
                      {occ.full_name ?? "—"}
                    </div>
                    <div className="text-xs text-muted-foreground truncate mt-1">
                      {occ.hospital_number ?? "—"}
                      {occ.bed ? ` · Bed ${occ.bed}` : ""}
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          )}

          {(() => {
            // Detect what the partner payload actually carries so we can hide
            // sections/rows that would otherwise show blank "—" everywhere.
            // Outliers, transfers and clinical acuity are not part of the
            // current /bridge/beds contract; treat any future dynamic keys
            // as available if they appear as arrays / non-null values.
            const raw = lastOk as unknown as Record<string, unknown>;
            const outliersProvided = Array.isArray(raw.outliers);
            const transfersProvided = Array.isArray(raw.transfers_out);
            const allOccupants = [
              ...lastOk.bed_board
                .map((b) => b.occupant)
                .filter((o): o is PartnerOccupant => o !== null),
              ...lastOk.unassigned,
            ];
            const acuityProvided = allOccupants.some(
              (o) => o.status != null && String(o.status).trim() !== "",
            );
            const outliers = outliersProvided
              ? (raw.outliers as unknown[])
              : [];
            const transfers = transfersProvided
              ? (raw.transfers_out as unknown[])
              : [];

            return (
              <>
                <section aria-labelledby="outliers-heading">
                  <h2
                    id="outliers-heading"
                    className="text-sm font-semibold text-muted-foreground mb-2"
                  >
                    Outliers
                  </h2>
                  {!outliersProvided ? (
                    <EmptyStateCard
                      title="Outliers not available"
                      body="The ICU Handover Hub bridge does not expose outliers yet. Manage outliers there — they will appear here once the partner exposes them."
                    />
                  ) : outliers.length === 0 ? (
                    <EmptyStateCard
                      title="No outliers"
                      body="No patients are currently outlying from the unit."
                      tone="ok"
                    />
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      {outliers.length} outlier(s)
                    </div>
                  )}
                </section>

                <section aria-labelledby="transfers-heading">
                  <h2
                    id="transfers-heading"
                    className="text-sm font-semibold text-muted-foreground mb-2"
                  >
                    Transfers out
                  </h2>
                  {!transfersProvided ? (
                    <EmptyStateCard
                      title="Transfers not available"
                      body="The ICU Handover Hub bridge does not expose out-transfers yet. Manage transfers there — they will appear here once the partner exposes them."
                    />
                  ) : transfers.length === 0 ? (
                    <EmptyStateCard
                      title="No open transfers"
                      body="No patients are currently awaiting transfer out."
                      tone="ok"
                    />
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      {transfers.length} transfer(s)
                    </div>
                  )}
                </section>

                <section
                  className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
                  aria-label="Bed board provenance"
                >
                  <div className="flex items-start gap-2">
                    <Activity
                      className="w-3.5 h-3.5 mt-0.5 shrink-0"
                      aria-hidden="true"
                    />
                    <div>
                      Occupancy is mirrored from{" "}
                      <span className="font-medium">ICU Handover Hub</span>{" "}
                      every 20 seconds.
                      {!acuityProvided && (
                        <>
                          {" "}
                          Clinical acuity flags (level, ventilation,
                          isolation, vasopressors) are not exposed by the
                          bridge yet — they will appear once the partner adds
                          them.
                        </>
                      )}
                    </div>
                  </div>
                </section>
              </>
            );
          })()}

        </div>
      )}

      <EditOccupantDialog
        occupant={selected}
        currentLevel={selected ? acuityMap.get(selected.id)?.level ?? null : null}
        currentOneToOne={selected ? acuityMap.get(selected.id)?.one_to_one === true : false}
        sourceReferralId={search.source_referral_id ?? null}
        onClose={() => setSelected(null)}
        onSaved={(updated) => {
          setSelected(updated);
          refetch();
        }}
        onAcuityChanged={() => refetchAcuity()}
      />


    </div>
  );
}

type EditForm = {
  full_name: string;
  hospital_number: string;
  age: string;
  bed: string;
  status: "referred" | "admitted" | "discharged" | "died";
  tep_in_place: boolean;
  tep_details: string;
  dnacpr_decision: boolean;
  dnacpr_details: string;
  outstanding_tasks: string;
};

function occupantToForm(o: PartnerOccupant): EditForm {
  const s = (o.status ?? "admitted") as EditForm["status"];
  return {
    full_name: o.full_name ?? "",
    hospital_number: o.hospital_number ?? "",
    age: o.age != null ? String(o.age) : "",
    bed: o.bed ?? "",
    status: ["referred", "admitted", "discharged", "died"].includes(s) ? s : "admitted",
    tep_in_place: o.tep_in_place === true,
    tep_details: o.tep_details ?? "",
    dnacpr_decision: o.dnacpr_decision === true,
    dnacpr_details: o.dnacpr_details ?? "",
    outstanding_tasks: o.outstanding_tasks ?? "",
  };
}

function buildDiff(
  initial: EditForm,
  current: EditForm,
  id: string,
  expected_updated_at: string | null,
): UpdatePartnerPatientInput {
  const out: UpdatePartnerPatientInput = { id, expected_updated_at };
  const strKeys = [
    "full_name",
    "hospital_number",
    "bed",
    "tep_details",
    "dnacpr_details",
    "outstanding_tasks",
  ] as const;
  for (const k of strKeys) {
    if (initial[k] !== current[k]) {
      let value: string | null = current[k] === "" ? null : current[k];
      // Hard guarantee: the "full_name" field on the partner is used as the
      // initials carrier. Never let a full name leak across the bridge.
      if (k === "full_name" && typeof value === "string") {
        value = toInitials(value) || null;
      }
      (out as Record<string, unknown>)[k] = value;
    }
  }
  if (initial.age !== current.age) {
    out.age = current.age === "" ? null : Number(current.age);
  }
  if (initial.status !== current.status) out.status = current.status;
  if (initial.tep_in_place !== current.tep_in_place) out.tep_in_place = current.tep_in_place;
  if (initial.dnacpr_decision !== current.dnacpr_decision) {
    out.dnacpr_decision = current.dnacpr_decision;
  }
  return out;
}

function EditOccupantDialog({
  occupant,
  currentLevel,
  currentOneToOne,
  sourceReferralId,
  onClose,
  onSaved,
  onAcuityChanged,
}: {
  occupant: PartnerOccupant | null;
  currentLevel: AcuityLevel | null;
  currentOneToOne: boolean;
  sourceReferralId: string | null;
  onClose: () => void;
  onSaved: (updated: PartnerOccupant) => void;
  onAcuityChanged: () => void;
}) {
  const save = useServerFn(updatePartnerPatient);
  const saveAcuity = useServerFn(setPatientAcuity);
  const runPrefill = useServerFn(prefillPartnerHandoverFromReferral);
  const acuityMutation = useMutation({
    mutationFn: (level: AcuityLevel | null) =>
      saveAcuity({ data: { partner_patient_id: occupant!.id, level } }),
    onSuccess: (result) => {
      if (result.ok) {
        toast.success("Level of care updated");
        onAcuityChanged();
      } else {
        toast.error(result.error || "Could not save level");
      }
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save level"),
  });
  const oneToOneMutation = useMutation({
    mutationFn: (one_to_one: boolean) =>
      saveAcuity({ data: { partner_patient_id: occupant!.id, one_to_one } }),
    onSuccess: (result, vars) => {
      if (result.ok) {
        toast.success(vars ? "Marked as 1:1 nursing" : "1:1 nursing cleared");
        onAcuityChanged();
      } else {
        toast.error(result.error || "Could not update 1:1 nursing");
      }
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Could not update 1:1 nursing"),
  });

  const prefillMutation = useMutation({
    mutationFn: () =>
      runPrefill({
        data: {
          referral_id: sourceReferralId!,
          partner_patient_id: occupant!.id,
        },
      }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error(result.error || "Could not prefill handover");
        return;
      }
      if (result.applied_fields.length === 0) {
        toast.info(
          result.skipped_fields.length > 0
            ? "Handover fields already populated — nothing to prefill."
            : "Referral had no clinical detail to prefill.",
        );
        return;
      }
      toast.success(
        `Prefilled ${result.applied_fields.length} handover field${
          result.applied_fields.length === 1 ? "" : "s"
        } from the referral`,
      );
      onSaved({
        ...(occupant as PartnerOccupant),
        updated_at: result.updated_at ?? (occupant as PartnerOccupant).updated_at,
      });
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Prefill failed"),
  });
  const initial = useMemo(
    () => (occupant ? occupantToForm(occupant) : null),
    [occupant],
  );
  const [form, setForm] = useState<EditForm | null>(initial);
  const [conflict, setConflict] = useState<{
    current: PartnerOccupant;
    your_expected_updated_at: string | null;
  } | null>(null);

  // Reset form whenever the selected occupant changes (open/close/switch).
  useEffect(() => {
    setForm(initial);
    setConflict(null);
  }, [initial]);

  const mutation = useMutation({
    mutationFn: (input: UpdatePartnerPatientInput) => save({ data: input }),
    onSuccess: (result) => {
      if (result.ok) {
        toast.success("Patient updated in ICU Handover Hub");
        onSaved(result.patient);
        return;
      }
      if (result.status === 409 && result.conflict) {
        setConflict(result.conflict);
        toast.warning("Someone else updated this patient — review and re-apply");
        return;
      }
      toast.error(result.error || "Update failed");
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Update failed");
    },
  });

  const canSubmit =
    !!occupant && !!form && !!initial && JSON.stringify(form) !== JSON.stringify(initial);

  return (
    <Dialog open={!!occupant} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit patient</DialogTitle>
          <DialogDescription>
            Changes write back to ICU Handover Hub over the signed bridge.
          </DialogDescription>
        </DialogHeader>

        {occupant && sourceReferralId && (
          <div
            className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm"
            role="region"
            aria-label="Prefill handover from referral"
          >
            <div className="flex items-start gap-2">
              <Sparkles
                className="w-4 h-4 mt-0.5 text-primary"
                aria-hidden="true"
              />
              <div className="flex-1">
                <div className="font-medium">Prefill handover from referral</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Copies TEP / DNACPR status, past medical history, reason for
                  admission and anticipated management from the linked referral.
                  Fields that already have content on the partner are left
                  untouched.
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                onClick={() => prefillMutation.mutate()}
                disabled={prefillMutation.isPending}
              >
                {prefillMutation.isPending ? (
                  <Loader2
                    className="w-3.5 h-3.5 mr-1 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Sparkles className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
                )}
                Prefill
              </Button>
            </div>
          </div>
        )}


        {conflict && (
          <div
            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
            role="alert"
          >
            <div className="font-medium flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4" aria-hidden="true" />
              This patient was updated by someone else
            </div>
            <div className="text-xs mt-1 text-muted-foreground">
              Their latest values are loaded below. Re-apply your changes on top
              and save again.
            </div>
            <div className="mt-2 flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => {
                  const fresh = occupantToForm(conflict.current);
                  setForm(fresh);
                  setConflict(null);
                }}
              >
                Load latest
              </Button>
            </div>
          </div>
        )}

        {occupant && (
          <div className="rounded-md border px-3 py-2">
            <div className="flex items-center justify-between gap-2 mb-2">
              <Label className="text-sm">Level of care</Label>
              {currentLevel != null && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 disabled:opacity-50"
                  disabled={acuityMutation.isPending}
                  onClick={() => acuityMutation.mutate(null)}
                >
                  Clear
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {([0, 1, 2, 3] as const).map((l) => {
                const selected = currentLevel === l;
                return (
                  <button
                    key={l}
                    type="button"
                    disabled={acuityMutation.isPending}
                    onClick={() => acuityMutation.mutate(l)}
                    className={`rounded-md border px-3 py-1.5 text-sm transition disabled:opacity-50 ${
                      selected ? LEVEL_TONE[l] + " ring-2 ring-offset-1 ring-current" : "hover:bg-accent"
                    }`}
                    title={LEVEL_LABEL[l]}
                    aria-pressed={selected}
                    aria-label={LEVEL_LABEL[l]}
                  >
                    L{l}
                  </button>
                );
              })}
            </div>
            <div className="mt-3 flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-2.5 py-2">
              <div className="min-w-0">
                <Label htmlFor="one-to-one-switch" className="text-sm">
                  Requires 1:1 nursing
                </Label>
                <div className="text-[11px] text-muted-foreground">
                  Forces this patient to count as a full nurse in unit dependency,
                  regardless of level of care.
                </div>
              </div>
              <Switch
                id="one-to-one-switch"
                checked={currentOneToOne}
                disabled={oneToOneMutation.isPending}
                onCheckedChange={(v) => oneToOneMutation.mutate(v === true)}
                aria-label="Requires 1:1 nursing"
              />
            </div>
            <div className="text-[11px] text-muted-foreground mt-1.5">
              Level of care is stored in this app and feeds unit acuity. Other
              patient details write back to ICU Handover Hub.
            </div>
          </div>
        )}



        {occupant && form && (
          <form
            className="grid grid-cols-2 gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!initial) return;
              const diff = buildDiff(
                initial,
                form,
                occupant.id,
                occupant.updated_at,
              );
              mutation.mutate(diff);
            }}
          >
            <div className="col-span-2">
              <Label htmlFor="full_name">Patient initials</Label>
              <Input
                id="full_name"
                value={form.full_name}
                onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                onBlur={(e) => setForm({ ...form, full_name: toInitials(e.target.value) })}
                maxLength={40}
                placeholder="e.g. JS"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Initials only (max 10 letters). Full names are automatically converted
                before saving and sharing with ICU Handover Hub over the signed bridge.
              </p>
            </div>
            <div>
              <Label htmlFor="hospital_number">Hospital #</Label>
              <Input
                id="hospital_number"
                value={form.hospital_number}
                onChange={(e) =>
                  setForm({ ...form, hospital_number: e.target.value })
                }
              />
            </div>
            <div>
              <Label htmlFor="age">Age</Label>
              <Input
                id="age"
                type="number"
                min={0}
                max={130}
                value={form.age}
                onChange={(e) => setForm({ ...form, age: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="bed">Bed</Label>
              <Input
                id="bed"
                value={form.bed}
                onChange={(e) => setForm({ ...form, bed: e.target.value })}
                placeholder="e.g. 4 or SR1"
              />
            </div>
            <div>
              <Label htmlFor="status">Status</Label>
              <Select
                value={form.status}
                onValueChange={(v) =>
                  setForm({ ...form, status: v as EditForm["status"] })
                }
              >
                <SelectTrigger id="status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="referred">Referred</SelectItem>
                  <SelectItem value="admitted">Admitted</SelectItem>
                  <SelectItem value="discharged">Discharged</SelectItem>
                  <SelectItem value="died">Died</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="col-span-2 flex items-center justify-between border rounded-md px-3 py-2">
              <Label htmlFor="tep_in_place" className="flex-1">
                TEP in place
              </Label>
              <Switch
                id="tep_in_place"
                checked={form.tep_in_place}
                onCheckedChange={(v) => setForm({ ...form, tep_in_place: v })}
              />
            </div>
            {form.tep_in_place && (
              <div className="col-span-2">
                <Label htmlFor="tep_details">TEP details</Label>
                <Textarea
                  id="tep_details"
                  rows={2}
                  value={form.tep_details}
                  onChange={(e) =>
                    setForm({ ...form, tep_details: e.target.value })
                  }
                />
              </div>
            )}

            <div className="col-span-2 flex items-center justify-between border rounded-md px-3 py-2">
              <Label htmlFor="dnacpr" className="flex-1">
                DNACPR decision
              </Label>
              <Switch
                id="dnacpr"
                checked={form.dnacpr_decision}
                onCheckedChange={(v) =>
                  setForm({ ...form, dnacpr_decision: v })
                }
              />
            </div>
            {form.dnacpr_decision && (
              <div className="col-span-2">
                <Label htmlFor="dnacpr_details">DNACPR details</Label>
                <Textarea
                  id="dnacpr_details"
                  rows={2}
                  value={form.dnacpr_details}
                  onChange={(e) =>
                    setForm({ ...form, dnacpr_details: e.target.value })
                  }
                />
              </div>
            )}

            <div className="col-span-2">
              <Label htmlFor="tasks">Outstanding tasks</Label>
              <Textarea
                id="tasks"
                rows={3}
                value={form.outstanding_tasks}
                onChange={(e) =>
                  setForm({ ...form, outstanding_tasks: e.target.value })
                }
              />
            </div>

            <DialogFooter className="col-span-2 mt-2">
              <div className="text-xs text-muted-foreground mr-auto self-center">
                Last updated {formatUpdated(occupant.updated_at)}
              </div>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canSubmit || mutation.isPending}>
                {mutation.isPending && (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" aria-hidden="true" />
                )}
                Save changes
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

