import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Bed as BedIcon,
  RefreshCcw,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";
import {
  getPartnerBedBoard,
  type PartnerBedSlot,
  type PartnerOccupant,
} from "@/lib/partner-bed-board.functions";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const QK = ["partner-bed-board"] as const;

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

function BedCard({
  slot,
  onOccupiedClick,
}: {
  slot: PartnerBedSlot;
  onOccupiedClick: (o: PartnerOccupant) => void;
}) {
  const occ = slot.occupant;
  if (!slot.occupied || !occ) {
    return (
      <Card
        className="p-3 flex flex-col justify-between min-h-24 border-dashed bg-muted/20"
        aria-label={`Empty bed ${slot.bed}`}
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
        <div className="text-center text-xs text-muted-foreground">Empty</div>
      </Card>
    );
  }
  const day = dayOfStay(occ.admission_date);
  return (
    <Card
      className="p-3 min-h-24 hover:bg-accent/40 cursor-pointer transition"
      onClick={() => onOccupiedClick(occ)}
      role="button"
      tabIndex={0}
      aria-label={`Bed ${slot.bed} — ${occ.full_name ?? "occupied"}`}
      onKeyDown={(e) =>
        (e.key === "Enter" || e.key === " ") && onOccupiedClick(occ)
      }
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          <BedIcon className="w-4 h-4" aria-hidden="true" />
          {slot.bed}
        </div>
        <div className="flex items-center gap-1">
          {slot.is_side_room && (
            <Badge variant="outline" className="text-[10px]">
              Side room
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
      {occ.dnacpr_decision && (
        <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-400 truncate">
          DNACPR: {occ.dnacpr_decision}
        </div>
      )}
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

function BedBoardPage() {
  const fetchBoard = useServerFn(getPartnerBedBoard);
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

  const [selected, setSelected] = useState<PartnerOccupant | null>(null);

  // If we get an ok:false response, surface it as an error banner but keep the
  // prior successful payload rendered so the board doesn't blank out on a
  // transient partner blip.
  const lastOk = data && data.ok ? data : null;
  const partnerError = data && !data.ok ? data.error : null;

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

      {lastOk && (
        <div
          className="flex flex-wrap items-center gap-2 mb-4"
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
      )}

      {partnerError && (
        <div
          className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200"
          role="alert"
        >
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="w-4 h-4" aria-hidden="true" />
            Bed board did not refresh
          </div>
          <div className="text-xs mt-1 break-words">{partnerError}</div>
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
              {lastOk.bed_board.map((slot) => (
                <BedCard
                  key={slot.bed}
                  slot={slot}
                  onOccupiedClick={setSelected}
                />
              ))}
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
                Occupancy, acuity, outliers and transfers are managed in{" "}
                <span className="font-medium">ICU Handover Hub</span>. This
                board mirrors its live snapshot every 20 seconds. Clinical
                acuity flags (level, ventilation, isolation, etc.), outliers
                and out-transfers will appear here once the partner exposes
                them over the bridge.
              </div>
            </div>
          </section>
        </div>
      )}

      <Dialog open={!!selected} onOpenChange={(v) => !v && setSelected(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{selected?.full_name ?? "Patient"}</DialogTitle>
            <DialogDescription>
              Read-only view — edit in ICU Handover Hub.
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <dl className="grid grid-cols-3 gap-x-3 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Hospital #</dt>
              <dd className="col-span-2 font-mono">
                {selected.hospital_number ?? "—"}
              </dd>
              <dt className="text-muted-foreground">Age</dt>
              <dd className="col-span-2">
                {selected.age != null ? `${selected.age}` : "—"}
              </dd>
              <dt className="text-muted-foreground">Bed</dt>
              <dd className="col-span-2">{selected.bed ?? "—"}</dd>
              <dt className="text-muted-foreground">Status</dt>
              <dd className="col-span-2">{selected.status ?? "—"}</dd>
              <dt className="text-muted-foreground">Admitted</dt>
              <dd className="col-span-2">
                {selected.admission_date
                  ? new Date(selected.admission_date).toLocaleString()
                  : "—"}
                {(() => {
                  const d = dayOfStay(selected.admission_date);
                  return d != null ? ` · Day ${d}` : "";
                })()}
              </dd>
              <dt className="text-muted-foreground">TEP</dt>
              <dd className="col-span-2">
                {selected.tep_in_place ? "In place" : "Not recorded"}
              </dd>
              <dt className="text-muted-foreground">DNACPR</dt>
              <dd className="col-span-2">
                {selected.dnacpr_decision ?? "—"}
              </dd>
              <dt className="text-muted-foreground">Tasks</dt>
              <dd className="col-span-2 whitespace-pre-wrap">
                {selected.outstanding_tasks ?? "—"}
              </dd>
              <dt className="text-muted-foreground">Updated</dt>
              <dd className="col-span-2">
                {formatUpdated(selected.updated_at)}
              </dd>
            </dl>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
