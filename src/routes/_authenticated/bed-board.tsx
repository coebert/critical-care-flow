import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getBedBoard,
  admitToBed,
  updateOccupancy,
  dischargeOccupancy,
  moveOccupancy,
  createOutlier,
  endOutlier,
  createTransferOut,
  updateTransferOut,
  cancelTransferOut,
} from "@/lib/beds.functions";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { computeCapacity } from "@/lib/bed-capacity";
import { CapacityStrip } from "@/components/bed-board/capacity-strip";
import { BedGrid } from "@/components/bed-board/bed-grid";
import { AdmitDialog, EditOccupancyDialog, MoveDialog, type OccupancyFormValue } from "@/components/bed-board/dialogs";
import { OutliersPanel, TransfersPanel } from "@/components/bed-board/side-panels";
import { NurseCapacityPanel } from "@/components/bed-board/nurse-capacity-panel";

type Bed = Database["public"]["Tables"]["beds"]["Row"];
type Occ = Database["public"]["Tables"]["bed_occupancies"]["Row"];
type Transfer = Database["public"]["Tables"]["bed_transfers_out"]["Row"];

const QK = ["bed-board"] as const;

export const Route = createFileRoute("/_authenticated/bed-board")({
  head: () => ({
    meta: [
      { title: "Bed board — SDH Critical Care" },
      { name: "description", content: "Live ICU/HDU bed board and capacity snapshot." },
    ],
  }),
  validateSearch: (s: Record<string, unknown>) => {
    const rawShift = s.focus_shift;
    const rawLevel = s.focus_level;
    const shift =
      rawShift === "day" || rawShift === "night" ? rawShift : undefined;
    // Accept numeric or numeric-string level (deep links from push payloads
    // that survive a query-string roundtrip both work).
    const levelNum =
      typeof rawLevel === "number"
        ? rawLevel
        : typeof rawLevel === "string" && /^[123]$/.test(rawLevel)
          ? Number(rawLevel)
          : undefined;
    const level = levelNum === 1 || levelNum === 2 || levelNum === 3 ? (levelNum as 1 | 2 | 3) : undefined;
    // Flag when a caller supplied a focus param but it was unusable, or when
    // they only supplied one half of the shift+level pair. Either case
    // triggers the graceful fallback banner in the component.
    const shiftProvided = rawShift !== undefined && rawShift !== null && rawShift !== "";
    const levelProvided = rawLevel !== undefined && rawLevel !== null && rawLevel !== "";
    const focus_invalid =
      (shiftProvided && !shift) ||
      (levelProvided && !level) ||
      (shiftProvided && !levelProvided) ||
      (levelProvided && !shiftProvided);
    return {
      source_referral_id: typeof s.source_referral_id === "string" ? s.source_referral_id : undefined,
      source_postop_booking_id: typeof s.source_postop_booking_id === "string" ? s.source_postop_booking_id : undefined,
      hospital_number: typeof s.hospital_number === "string" ? s.hospital_number : undefined,
      patient_initials: typeof s.patient_initials === "string" ? s.patient_initials : undefined,
      admitting_consultant: typeof s.admitting_consultant === "string" ? s.admitting_consultant : undefined,
      level: typeof s.level === "number" ? s.level : undefined,
      source_label: typeof s.source_label === "string" ? s.source_label : undefined,
      focus_shift: shift,
      focus_level: level,
      focus_invalid: focus_invalid || undefined,
    };
  },
  component: BedBoardPage,
});

// Local ICU convention: day shift 08:00-19:59, night shift otherwise.
function currentShiftFromClock(now = new Date()): "day" | "night" {
  const h = now.getHours();
  return h >= 8 && h < 20 ? "day" : "night";
}


function toIsoOrNull(v: string | null): string | null {
  if (!v) return null;
  const d = new Date(v);
  return isFinite(d.getTime()) ? d.toISOString() : null;
}

function BedBoardPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const fetchBoard = useServerFn(getBedBoard);
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: QK,
    queryFn: () => fetchBoard(),
    staleTime: 5_000,
  });


  useEffect(() => {
    const ch = supabase
      .channel("bed-board")
      .on("postgres_changes", { event: "*", schema: "public", table: "bed_occupancies" }, () =>
        qc.invalidateQueries({ queryKey: QK }),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "bed_outliers" }, () =>
        qc.invalidateQueries({ queryKey: QK }),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "bed_transfers_out" }, () =>
        qc.invalidateQueries({ queryKey: QK }),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "beds" }, () =>
        qc.invalidateQueries({ queryKey: QK }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [qc]);

  const beds = data?.beds ?? [];
  const occupancies = data?.occupancies ?? [];
  const outliers = data?.outliers ?? [];
  const transfers = data?.transfers ?? [];

  const snapshot = useMemo(
    () =>
      computeCapacity({
        beds,
        occupancies,
        outliers_count: outliers.length,
        open_transfers_count: transfers.length,
      }),
    [beds, occupancies, outliers.length, transfers.length],
  );

  const liveBedIds = useMemo(() => new Set(occupancies.map((o) => o.bed_id)), [occupancies]);

  // Dialog state
  const [admitBed, setAdmitBed] = useState<Bed | null>(null);
  const [editOcc, setEditOcc] = useState<Occ | null>(null);
  const [moveOcc, setMoveOcc] = useState<Occ | null>(null);
  const [saving, setSaving] = useState(false);

  const editBedCode =
    editOcc ? beds.find((b) => b.id === editOcc.bed_id)?.code ?? "" : "";

  // Server fn hooks
  const doAdmit = useServerFn(admitToBed);
  const doUpdate = useServerFn(updateOccupancy);
  const doDischarge = useServerFn(dischargeOccupancy);
  const doMove = useServerFn(moveOccupancy);
  const doCreateOutlier = useServerFn(createOutlier);
  const doEndOutlier = useServerFn(endOutlier);
  const doCreateTransfer = useServerFn(createTransferOut);
  const doUpdateTransfer = useServerFn(updateTransferOut);
  const doCancelTransfer = useServerFn(cancelTransferOut);

  const refresh = () => qc.invalidateQueries({ queryKey: QK });

  const wrap = async <T,>(op: () => Promise<T>, ok: string) => {
    setSaving(true);
    try {
      await op();
      toast.success(ok);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  };

  const admitPrefill = search.source_referral_id || search.source_postop_booking_id
    ? {
        hospital_number: search.hospital_number ?? null,
        patient_initials: search.patient_initials ?? null,
        admitting_consultant: search.admitting_consultant ?? null,
        level: (search.level === 1 || search.level === 2 || search.level === 3 ? search.level : 3) as 1 | 2 | 3,
      }
    : undefined;
  const clearAdmitSource = () =>
    navigate({
      search: {
        source_referral_id: undefined,
        source_postop_booking_id: undefined,
        hospital_number: undefined,
        patient_initials: undefined,
        admitting_consultant: undefined,
        level: undefined,
        source_label: undefined,
      },
      replace: true,
    });

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Bed board</h1>
          <p className="text-sm text-muted-foreground">Live occupancy, outliers and transfers.</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Link to="/board" className="rounded-md border px-3 py-1.5 hover:bg-accent">TV / whiteboard mode</Link>
          <Link to="/board/ward-round" className="rounded-md border px-3 py-1.5 hover:bg-accent">Ward round list</Link>
        </div>
      </div>

      <CapacityStrip snapshot={snapshot} />

      {admitPrefill && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-md border bg-primary/5 px-3 py-2 text-sm">
          <div>
            Admitting from <span className="font-medium">{search.source_label ?? "referral"}</span>
            {search.patient_initials ? <> · <span className="font-mono">{search.patient_initials}</span></> : null}
            . Click an empty bed to place the patient.
          </div>
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
            onClick={clearAdmitSource}
          >
            Cancel
          </button>
        </div>
      )}

      {(() => {
        // Graceful fallback: derive effective focus values from whatever was
        // provided. Missing shift falls back to the shift active on the clock
        // now; missing level falls back to Level 3 (most acute). If nothing
        // usable was supplied and nothing was requested, render no banner.
        const anyRequested = search.focus_shift || search.focus_level || search.focus_invalid;
        if (!anyRequested) return null;
        const effectiveShift: "day" | "night" =
          search.focus_shift ?? currentShiftFromClock();
        const effectiveLevel: 1 | 2 | 3 = search.focus_level ?? 3;
        return (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
            <div>
              Reviewing{" "}
              <span className="font-medium">
                {effectiveShift === "night" ? "Night" : "Day"} shift
              </span>
              {" · "}
              <span className="font-medium">
                Level {effectiveLevel}
                {effectiveLevel === 1 ? "/0" : ""}
              </span>{" "}
              admission capacity.
              {search.focus_invalid && (
                <span className="ml-2 text-xs text-muted-foreground">
                  Deep link was incomplete or invalid — showing{" "}
                  {!search.focus_shift ? "current shift" : "Level 3"} by default.
                </span>
              )}
            </div>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
              onClick={() =>
                navigate({
                  search: {
                    ...search,
                    focus_shift: undefined,
                    focus_level: undefined,
                    focus_invalid: undefined,
                  },
                  replace: true,
                })
              }
            >
              Clear
            </button>
          </div>
        );
      })()}


      {isLoading && (
        <div className="text-sm text-muted-foreground">Loading bed board…</div>
      )}
      {error && (
        <div className="text-sm text-destructive" role="alert">
          Failed to load bed board: {error instanceof Error ? error.message : "unknown"}
        </div>
      )}


      {!isLoading && !error && (
        <div className="grid lg:grid-cols-[1fr_320px] gap-6">
          <BedGrid
            beds={beds}
            occupancies={occupancies}
            onEmptyClick={setAdmitBed}
            onOccupiedClick={setEditOcc}
          />
          <div className="space-y-4">
            <NurseCapacityPanel
              occupancies={occupancies}
              focusShift={search.focus_shift as "day" | "night" | undefined}
              focusLevel={search.focus_level as 1 | 2 | 3 | undefined}
            />
            <OutliersPanel
              outliers={outliers}
              saving={saving}
              onCreate={(v) => wrap(() => doCreateOutlier({ data: v }), "Outlier added")}
              onEnd={(id) => wrap(() => doEndOutlier({ data: { id } }), "Outlier ended")}
            />
            <TransfersPanel
              transfers={transfers}
              saving={saving}
              onCreate={(v) => wrap(() => doCreateTransfer({ data: v }), "Transfer created")}
              onAdvance={(id, next) =>
                wrap(() => doUpdateTransfer({ data: { id, status: next } }), "Transfer updated")
              }
              onCancel={(id) => wrap(() => doCancelTransfer({ data: { id } }), "Transfer cancelled")}
            />
          </div>
        </div>
      )}

      <AdmitDialog
        open={!!admitBed}
        bed={admitBed}
        saving={saving}
        initial={admitPrefill}
        sourceLabel={admitPrefill ? search.source_label ?? "referral" : undefined}
        onOpenChange={(v) => !v && setAdmitBed(null)}
        onSubmit={(value) => {
          if (!admitBed) return;
          const payload = {
            bed_id: admitBed.id,
            admitted_at: value.admitted_at,
            hospital_number: value.hospital_number,
            patient_initials: value.patient_initials,
            admitting_consultant: value.admitting_consultant,
            level: value.level,
            ventilated: value.ventilated,
            nippv_cpap: value.nippv_cpap,
            hfno: value.hfno,
            vasopressors: value.vasopressors,
            renal_replacement: value.renal_replacement,
            tracheostomy: value.tracheostomy,
            isolation: value.isolation,
            isolation_reason: value.isolation_reason,
            requires_side_room: value.requires_side_room,
            predicted_discharge_at: toIsoOrNull(value.predicted_discharge_at),
            predicted_step_down: value.predicted_step_down,
            notes: value.notes,
            source_referral_id: search.source_referral_id ?? null,
            source_postop_booking_id: search.source_postop_booking_id ?? null,
          };
          wrap(() => doAdmit({ data: payload }), "Admitted").then(() => {
            setAdmitBed(null);
            if (admitPrefill) clearAdmitSource();
          });
        }}
      />


      <EditOccupancyDialog
        open={!!editOcc}
        occupancy={editOcc}
        bedCode={editBedCode}
        saving={saving}
        onOpenChange={(v) => !v && setEditOcc(null)}
        onSave={(v: OccupancyFormValue) => {
          if (!editOcc) return;
          wrap(
            () =>
              doUpdate({
                data: {
                  id: editOcc.id,
                  hospital_number: v.hospital_number,
                  patient_initials: v.patient_initials,
                  admitting_consultant: v.admitting_consultant,
                  level: v.level,
                  ventilated: v.ventilated,
                  nippv_cpap: v.nippv_cpap,
                  hfno: v.hfno,
                  vasopressors: v.vasopressors,
                  renal_replacement: v.renal_replacement,
                  tracheostomy: v.tracheostomy,
                  isolation: v.isolation,
                  isolation_reason: v.isolation_reason,
                  requires_side_room: v.requires_side_room,
                  predicted_discharge_at: toIsoOrNull(v.predicted_discharge_at),
                  predicted_step_down: v.predicted_step_down,
                  notes: v.notes,
                },
              }),
            "Occupancy updated",
          ).then(() => setEditOcc(null));
        }}
        onDischarge={() => {
          if (!editOcc) return;
          wrap(() => doDischarge({ data: { id: editOcc.id } }), "Patient discharged").then(() =>
            setEditOcc(null),
          );
        }}
        onMove={() => {
          setMoveOcc(editOcc);
          setEditOcc(null);
        }}
      />

      <MoveDialog
        open={!!moveOcc}
        beds={beds}
        currentBedId={moveOcc?.bed_id ?? ""}
        liveBedIds={liveBedIds}
        saving={saving}
        onOpenChange={(v) => !v && setMoveOcc(null)}
        onConfirm={(new_bed_id) => {
          if (!moveOcc) return;
          wrap(() => doMove({ data: { id: moveOcc.id, new_bed_id } }), "Patient moved").then(
            () => setMoveOcc(null),
          );
        }}
      />
    </div>
  );
}

// Silence unused-import warnings for Transfer type in this file.
export type _T = Transfer;
