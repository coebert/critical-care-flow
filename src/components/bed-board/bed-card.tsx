import { useEffect, useRef, useState } from "react";
import { formatDistanceToNowStrict, formatDistanceStrict } from "date-fns";
import {
  Bed as BedIcon,
  Biohazard,
  Heart,
  ScanLine,
  ShieldCheck,
  Stethoscope,
  Swords,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { PartnerBedSlot, PartnerOccupant } from "@/lib/partner-bed-board-contract";
import type { AcuityLevel } from "@/lib/patient-acuity-core";
import { LEVEL_TONE, LEVEL_LABEL } from "@/lib/acuity";

function dayOfStay(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!isFinite(t)) return null;
  return Math.max(1, Math.floor((Date.now() - t) / 86_400_000) + 1);
}

export function WardableToggle({
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

export function DischargeControl({
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
        title={`Discharge time recorded here ${new Date(dischargedAt).toLocaleString()}${
          window ? ` — ${window} from wardable` : ""
        }. This is for timing only: the bed stays occupied until the patient is discharged in ICU Handover Hub. Click to undo.`}
        aria-label={`Discharge time recorded here${window ? `, ${window} from wardable` : ""}. Timing only — bed stays occupied until discharged in ICU Handover Hub. Activate to undo.`}
        className="mt-1 inline-flex items-center gap-1 rounded border border-sky-500/40 bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-800 dark:text-sky-300 hover:bg-sky-500/25 transition disabled:opacity-60"
      >
        <span aria-hidden="true">✓</span>
        <span>Discharge time recorded here{window ? ` · ${window}` : ""}</span>
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
          ? `Record discharge timing — logs time from wardable (${new Date(wardableAt).toLocaleString()}). Does not discharge the patient in ICU Handover Hub.`
          : "Record discharge timing for analytics. Does not discharge the patient in ICU Handover Hub."
      }
      aria-label="Record discharge timing (does not discharge the patient in ICU Handover Hub)"
      className="mt-1 inline-flex items-center gap-1 rounded border border-dashed px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground hover:bg-accent hover:text-foreground transition disabled:opacity-60"
    >
      <span aria-hidden="true">→</span>
      <span>Record discharge timing</span>
    </button>
  );
}

export type BedCardProps = {
  slot: PartnerBedSlot;
  level: AcuityLevel | undefined;
  oneToOne: boolean;
  hasTracheostomy: boolean;
  isolation: "contact" | "droplet" | "airborne" | null;
  isolationReason: string | null;
  isolationPending: boolean;
  onCycleIsolation: (
    occupantId: string,
    next: "none" | "contact" | "droplet" | "airborne",
  ) => void;

  violenceRisk: boolean;
  violencePending: boolean;
  onToggleViolenceRisk: (occupantId: string, next: boolean) => void;
  endOfLife: boolean;
  endOfLifePending: boolean;
  onToggleEndOfLife: (occupantId: string, next: boolean) => void;
  needsScanTransfer: boolean;
  scanTransferPending: boolean;
  onToggleScanTransfer: (occupantId: string, next: boolean) => void;
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
  /** Local wardable vs ICU Handover Hub mismatch (reconstructed after reload). */
  hubSync?: { mismatch: boolean; reason: string | null };
  hubSyncPending?: boolean;
  onRetryHubSync?: (occupantId: string) => void;
  /** Direct link to this patient in ICU Handover Hub (opaque id only). */
  hubPatientUrl?: string | null;
};

const SYNC_REASON_TEXT: Record<string, string> = {
  pending: "Hub update pending",
  failed: "Hub not updated",
  conflict: "Hub changed at the same time",
  not_shared: "No longer shared by Hub",
  not_configured: "Hub link not configured",
  hub_differs: "Hub shows a different wardable state",
};

/**
 * Bed card dispatcher. Holds NO hooks itself: each state (withheld /
 * empty / occupied) is its own component, so the same bed changing state
 * between refreshes can never violate the Rules of Hooks.
 */
export function BedCard(props: BedCardProps) {
  const { slot } = props;
  if (slot.occupied && !slot.occupant) return <WithheldBedCard slot={slot} />;
  if (!slot.occupied || !slot.occupant) {
    return <EmptyBedCard slot={slot} isDragTarget={props.isDragTarget} onMove={props.onMove} />;
  }
  return <OccupiedBedCard {...props} occ={slot.occupant} />;
}

function WithheldBedCard({ slot }: { slot: PartnerBedSlot }) {
    // Hub says the bed is occupied but withheld the occupant's details.
    // It is NEVER a free bed: not a drop target, not clickable.
    return (
      <Card
        className="p-3 h-full min-h-[120px] flex flex-col justify-between border-dashed bg-muted/40"
        aria-label={`Bed ${slot.bed} occupied — patient details withheld by ICU Handover Hub`}
        data-bed-state="occupied-withheld"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            <BedIcon className="w-4 h-4" aria-hidden="true" />
            {slot.bed}
          </div>
          {slot.is_side_room && (
            <Badge variant="outline" className="text-[10px]">
              Side room
            </Badge>
          )}
        </div>
        <div className="text-center text-xs">
          <div className="font-semibold">Occupied</div>
          <div className="text-muted-foreground">Details withheld</div>
        </div>
      </Card>
    );
  }

function EmptyBedCard({
  slot,
  isDragTarget,
  onMove,
}: Pick<BedCardProps, "slot" | "isDragTarget" | "onMove">) {

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

function OccupiedBedCard({
  slot,
  occ,
  level,
  oneToOne,
  hasTracheostomy,
  isolation,
  isolationReason,
  isolationPending,
  onCycleIsolation,

  violenceRisk,
  violencePending,
  onToggleViolenceRisk,
  endOfLife,
  endOfLifePending,
  onToggleEndOfLife,
  needsScanTransfer,
  scanTransferPending,
  onToggleScanTransfer,
  wardable,
  wardableAt,
  dischargedAt,
  wardablePending,
  dischargePending,
  onToggleWardable,
  onDischarge,
  onOccupiedClick,
  onDragStateChange,
  hubSync,
  hubSyncPending,
  onRetryHubSync,
  hubPatientUrl,
}: BedCardProps & { occ: PartnerOccupant }) {
  const day = dayOfStay(occ.admission_date);

  // Row-pulse: briefly highlight the card when the occupant's updated_at
  // changes so realtime edits from another user don't land silently.
  const prevUpdatedAt = useRef<string | null | undefined>(occ.updated_at);
  const [justUpdated, setJustUpdated] = useState(false);
  useEffect(() => {
    if (prevUpdatedAt.current && prevUpdatedAt.current !== occ.updated_at) {
      setJustUpdated(true);
      const t = window.setTimeout(() => setJustUpdated(false), 1600);
      return () => window.clearTimeout(t);
    }
    prevUpdatedAt.current = occ.updated_at;
  }, [occ.updated_at]);

  // Shared button wrapper — enforces a 32×32 hit target for toggle badges so
  // they're comfortable on touch while the visual badge stays compact.
  const toggleBtnClass =
    "inline-flex items-center justify-center min-h-8 min-w-8 p-1 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

  return (
    <Card
      className={`p-3 min-h-24 hover:bg-accent/40 cursor-grab active:cursor-grabbing transition ${
        justUpdated ? "motion-safe:animate-bed-pulse ring-2 ring-primary/60" : ""
      }`}
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
      {/* Primary row: bed code + patient identity on the left, acuity + room on the right. */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            <BedIcon className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="tabular-nums">{slot.bed}</span>
          </div>
          <div className="mt-0.5 text-sm font-medium truncate">
            {occ.full_name || "—"}
          </div>
          <div className="text-xs text-muted-foreground truncate">
            {occ.hospital_number ? `${occ.hospital_number}` : "—"}
            {occ.age != null ? ` · ${occ.age}y` : ""}
            {day != null ? ` · Day ${day}` : ""}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          {level != null && (
            <Badge
              variant="outline"
              className={`text-[10px] font-semibold ${LEVEL_TONE[level]}`}
              title={LEVEL_LABEL[level]}
              aria-label={LEVEL_LABEL[level]}
            >
              L{level}
            </Badge>
          )}
          {slot.is_side_room && (
            <Badge variant="outline" className="text-[10px]" title="Side room">
              SR
            </Badge>
          )}
          {oneToOne && (
            <Badge
              variant="outline"
              className="text-[10px] bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/30"
              title="Requires 1:1 nursing"
              aria-label="Requires 1:1 nursing"
            >
              1:1
            </Badge>
          )}
        </div>
      </div>

      {occ.dnacpr_decision === true && (
        <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-400 truncate">
          DNACPR{occ.dnacpr_details ? ` — ${occ.dnacpr_details}` : ""}
        </div>
      )}

      {/* Status badge row — fixed order: Isolation → EOL → Violence → Scan → Trache → TEP.
          Toggleable flags share the same 32×32 touch target. */}
      <div className="mt-2 flex flex-wrap items-center gap-0.5">
        {(() => {
          const cycle = { none: "contact", contact: "droplet", droplet: "airborne", airborne: "none" } as const;
          const current = isolation ?? "none";
          const next = cycle[current];
          const active = isolation != null;
          const toneClass = active
            ? "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30"
            : "bg-transparent text-muted-foreground border-dashed opacity-60";
          const label = active
            ? `Isolation: ${isolation}${isolationReason ? ` — ${isolationReason}` : ""}. Tap to change to ${next === "none" ? "no isolation" : next}.`
            : `Flag as needing isolation (next: contact)`;
          return (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (!isolationPending) onCycleIsolation(occ.id, next);
              }}
              disabled={isolationPending}
              title={label}
              aria-pressed={active}
              aria-label={label}
              className={toggleBtnClass}
            >
              <Badge variant="outline" className={`text-[10px] p-0.5 transition ${toneClass}`}>
                <Biohazard className="w-3.5 h-3.5" aria-hidden="true" />
              </Badge>
            </button>
          );
        })()}

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (!endOfLifePending) onToggleEndOfLife(occ.id, !endOfLife);
          }}
          disabled={endOfLifePending}
          title={endOfLife ? "End-of-life care — tap to clear" : "Flag as receiving end-of-life care"}
          aria-pressed={endOfLife}
          aria-label={endOfLife ? "Clear end-of-life-care flag" : "Flag patient as receiving end-of-life care"}
          className={toggleBtnClass}
        >
          <Badge
            variant="outline"
            className={`text-[10px] p-0.5 transition ${
              endOfLife
                ? "bg-violet-500/15 text-violet-700 dark:text-violet-400 border-violet-500/40"
                : "bg-transparent text-muted-foreground border-dashed opacity-60"
            }`}
          >
            <Heart className={`w-3.5 h-3.5 ${endOfLife ? "fill-current" : ""}`} aria-hidden="true" />
          </Badge>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (!violencePending) onToggleViolenceRisk(occ.id, !violenceRisk);
          }}
          disabled={violencePending}
          title={violenceRisk ? "Violence risk flagged — tap to clear" : "Flag as potentially violent or aggressive"}
          aria-pressed={violenceRisk}
          aria-label={violenceRisk ? "Clear violence-risk flag" : "Flag patient as potentially violent or aggressive"}
          className={toggleBtnClass}
        >
          <Badge
            variant="outline"
            className={`text-[10px] p-0.5 transition ${
              violenceRisk
                ? "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/40"
                : "bg-transparent text-muted-foreground border-dashed opacity-60"
            }`}
          >
            <Swords className="w-3.5 h-3.5" aria-hidden="true" />
          </Badge>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (!scanTransferPending) onToggleScanTransfer(occ.id, !needsScanTransfer);
          }}
          disabled={scanTransferPending}
          title={needsScanTransfer ? "Needs transfer for a scan — tap to clear" : "Flag as needing transfer for a scan"}
          aria-pressed={needsScanTransfer}
          aria-label={needsScanTransfer ? "Clear scan-transfer flag" : "Flag patient as needing transfer for a scan"}
          className={toggleBtnClass}
        >
          <Badge
            variant="outline"
            className={`text-[10px] p-0.5 transition ${
              needsScanTransfer
                ? "bg-indigo-500/15 text-indigo-700 dark:text-indigo-400 border-indigo-500/40"
                : "bg-transparent text-muted-foreground border-dashed opacity-60"
            }`}
          >
            <ScanLine className="w-3.5 h-3.5" aria-hidden="true" />
          </Badge>
        </button>
        {hasTracheostomy && (
          <span
            className="inline-flex items-center justify-center min-h-8 min-w-8"
            title="Tracheostomy in situ"
            aria-label="Tracheostomy in situ"
          >
            <Badge
              variant="outline"
              className="text-[10px] p-0.5 bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/30"
            >
              <Stethoscope className="w-3.5 h-3.5" aria-hidden="true" />
            </Badge>
          </span>
        )}
        {occ.tep_in_place && (
          <span
            className="inline-flex items-center justify-center min-h-8 min-w-8"
            title="Treatment Escalation Plan in place"
            aria-label="Treatment Escalation Plan in place"
          >
            <Badge variant="outline" className="text-[10px] p-0.5 gap-0.5">
              <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="text-[9px] leading-none">TEP</span>
            </Badge>
          </span>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
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
        {hubPatientUrl && (
          <a
            href={hubPatientUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            draggable={false}
            className="mt-1 inline-flex min-h-8 items-center rounded border px-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={`Open bed ${slot.bed} patient in ICU Handover Hub to discharge`}
            title="Discharge the patient in ICU Handover Hub (frees the bed)"
          >
            Discharge in Hub ↗
          </a>
        )}
      </div>
      {hubSync?.mismatch && (
        <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-amber-800 dark:text-amber-300" role="status">
          <span aria-hidden="true">⚠</span>
          <span>{SYNC_REASON_TEXT[hubSync.reason ?? "failed"] ?? "Hub not updated"} · wardable saved here</span>
          {onRetryHubSync && hubSync.reason !== "not_configured" && (
            <button
              type="button"
              className="min-h-8 rounded border border-amber-500/50 px-1.5 font-medium hover:bg-amber-500/10 disabled:opacity-50"
              disabled={hubSyncPending}
              onClick={(e) => {
                e.stopPropagation();
                onRetryHubSync(occ.id);
              }}
              onKeyDown={(e) => e.stopPropagation()}
              aria-label={`Retry updating ICU Handover Hub for bed ${slot.bed}`}
            >
              {hubSyncPending ? "Retrying…" : "Retry Hub"}
            </button>
          )}
        </div>
      )}
    </Card>
  );
}



