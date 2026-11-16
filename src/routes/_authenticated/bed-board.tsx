import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, Biohazard, ChevronDown, HelpCircle, RefreshCcw, Rows2, Rows3, ShieldCheck, Heart, ScanLine, Stethoscope, Swords, UserRound } from "lucide-react";
import { useDensity } from "@/hooks/use-density";
import { BedGridSkeleton } from "@/components/bed-board/bed-grid-skeleton";
import { formatDistanceToNowStrict } from "date-fns";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { updatePartnerPatient, type PartnerOccupant } from "@/lib/partner-bed-board.functions";
import { type AcuityLevel } from "@/lib/patient-acuity.functions";
import { getPatientAirways } from "@/lib/patient-airway.functions";
import {
  getPatientIsolations,
  setPatientIsolation,
  type PatientIsolationEntry,
} from "@/lib/patient-infection.functions";

import {
  listViolenceRisk,
  setViolenceRisk,
} from "@/lib/patient-violence-risk.functions";
import {
  listEndOfLife,
  setEndOfLife,
} from "@/lib/patient-end-of-life.functions";
import {
  listScanTransfer,
  setScanTransfer,
} from "@/lib/patient-scan-transfer.functions";
import {
  listWardableStatus,
  setWardableStatus,
  retryWardableSync,
  reviewWardableRetry,
  getHubAppOrigin,
  dischargePatient,
  clearDischarge,
  wardableMismatch,
  type WardableStatus,
  type SetWardableResult,
  type PartnerSyncOutcome,
  type WardableRetryReview,
} from "@/lib/wardable-status.functions";

import { BedCard } from "@/components/bed-board/bed-card";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { Switch } from "@/components/ui/switch";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

import {
  PARTNER_BOARD_QK as QK,
  ACUITY_QK,
  useUnitCapacity,
  usePatientAcuityRows,
  usePartnerBedBoard,
} from "@/hooks/use-unit-capacity";
import { CapacityFreshness, failureText } from "@/components/capacity/capacity-status";
import { formatUnitTime } from "@/lib/shift-clock";
import { getAdmissionSourceContext } from "@/lib/admission-source.functions";
import { parseBedBoardSearch, hasLegacyIdentifierParams } from "@/lib/bed-board-search";

import { LEVEL_TONE, LEVEL_LABEL, computeUnitAcuity } from "@/lib/acuity";
import { NurseCapacityPanel } from "@/components/bed-board/nurse-capacity-panel";
import { EditOccupantDialog } from "@/components/bed-board/edit-occupant-dialog";
import { useRequestGuard, type RequestTicket } from "@/lib/request-guard";

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
  // Deep-link context. Only OPAQUE ids and a neutral label are accepted —
  // patient identifiers (hospital number, initials, consultant) are never
  // read from the URL, and legacy links carrying them are rewritten on load.
  validateSearch: (s: Record<string, unknown>) => parseBedBoardSearch(s),
  component: BedBoardPage,
});

function formatUpdated(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return "—";
  return formatDistanceToNowStrict(d, { addSuffix: true });
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
  const { density, toggle: toggleDensity } = useDensity();

  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const capacity = useUnitCapacity();
  const fetchAirways = useServerFn(getPatientAirways);
  const fetchIsolations = useServerFn(getPatientIsolations);
  const fetchViolence = useServerFn(listViolenceRisk);
  const writeViolence = useServerFn(setViolenceRisk);
  const fetchEndOfLife = useServerFn(listEndOfLife);
  const writeEndOfLife = useServerFn(setEndOfLife);
  const fetchScanTransfer = useServerFn(listScanTransfer);
  const writeScanTransfer = useServerFn(setScanTransfer);
  const qc = useQueryClient();
  const board = usePartnerBedBoard();
  const { isLoading, isFetching, refetch } = board;
  const { data: acuityRows } = usePatientAcuityRows();
  // level null = no level observed (1:1 may still be recorded).
  type AcuityInfo = { level: AcuityLevel | null; one_to_one: boolean; updated_at: string };
  const acuityMap = useMemo(() => {
    const m = new Map<string, AcuityInfo>();
    for (const r of acuityRows ?? []) {
      m.set(r.partner_patient_id, {
        level: r.level,
        one_to_one: r.one_to_one === true,
        updated_at: r.updated_at,
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

  // End-of-life flag (user-toggleable, local source of truth).
  const { data: endOfLifeRows } = useQuery({
    queryKey: ["patient-end-of-life"],
    queryFn: () => fetchEndOfLife(),
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
  const endOfLifeSet = useMemo(() => {
    const s = new Set<string>();
    for (const r of endOfLifeRows ?? []) {
      if (r.end_of_life) s.add(r.partner_patient_id);
    }
    return s;
  }, [endOfLifeRows]);

  const endOfLifeMutation = useMutation({
    mutationFn: (v: { partner_patient_id: string; end_of_life: boolean }) =>
      writeEndOfLife({ data: v }),
    onSuccess: (_r, vars) => {
      toast.success(
        vars.end_of_life
          ? "Flagged as receiving end-of-life care"
          : "End-of-life flag cleared",
      );
      qc.invalidateQueries({ queryKey: ["patient-end-of-life"] });
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Could not update flag"),
  });
  const handleToggleEndOfLife = (occupantId: string, next: boolean) => {
    endOfLifeMutation.mutate({ partner_patient_id: occupantId, end_of_life: next });
  };

  // Scan-transfer flag (user-toggleable, local source of truth).
  const { data: scanTransferRows } = useQuery({
    queryKey: ["patient-scan-transfer"],
    queryFn: () => fetchScanTransfer(),
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
  const scanTransferSet = useMemo(() => {
    const s = new Set<string>();
    for (const r of scanTransferRows ?? []) {
      if (r.needs_scan_transfer) s.add(r.partner_patient_id);
    }
    return s;
  }, [scanTransferRows]);

  const scanTransferMutation = useMutation({
    mutationFn: (v: {
      partner_patient_id: string;
      needs_scan_transfer: boolean;
    }) => writeScanTransfer({ data: v }),
    onSuccess: (_r, vars) => {
      toast.success(
        vars.needs_scan_transfer
          ? "Flagged as needing transfer for a scan"
          : "Scan-transfer flag cleared",
      );
      qc.invalidateQueries({ queryKey: ["patient-scan-transfer"] });
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Could not update flag"),
  });
  const handleToggleScanTransfer = (occupantId: string, next: boolean) => {
    scanTransferMutation.mutate({
      partner_patient_id: occupantId,
      needs_scan_transfer: next,
    });
  };

  // Isolation cycle (user-toggleable, writes to bed_occupancies.isolation).
  const writeIsolation = useServerFn(setPatientIsolation);
  const isolationMutation = useMutation({
    mutationFn: (v: {
      partner_patient_id: string;
      isolation: "none" | "contact" | "droplet" | "airborne";
    }) => writeIsolation({ data: v }),
    onSuccess: (_r, vars) => {
      toast.success(
        vars.isolation === "none"
          ? "Isolation cleared"
          : `Isolation set to ${vars.isolation}`,
      );
      qc.invalidateQueries({ queryKey: ["patient-isolations"] });
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Could not update isolation"),
  });
  const handleCycleIsolation = (
    occupantId: string,
    next: "none" | "contact" | "droplet" | "airborne",
  ) => {
    isolationMutation.mutate({ partner_patient_id: occupantId, isolation: next });
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
  const retrySync = useServerFn(retryWardableSync);
  const fetchHubOrigin = useServerFn(getHubAppOrigin);
  const hubOrigin = useQuery({
    queryKey: ["hub-app-origin"],
    queryFn: () => fetchHubOrigin(),
    staleTime: Infinity,
    retry: false,
  });
  const hubPatientUrl = (id: string) =>
    hubOrigin.data?.origin ? `${hubOrigin.data.origin}/patients/${encodeURIComponent(id)}` : null;

  // Separate local-save vs Hub-update outcome, said plainly.
  const reportPartner = (p: PartnerSyncOutcome, savedWhat: string) => {
    if (p.status === "synced") toast.success(`${savedWhat} · ICU Handover Hub updated`);
    else if (p.status === "not_configured") toast.info(`${savedWhat} here only — Hub link not configured`);
    else toast.warning(`${savedWhat} here. ${p.message}`);
  };
  // Retry is explicit and reviewed: show the latest local desired state next
  // to what the Hub currently shows; only that reviewed revision is sent.
  const reviewRetry = useServerFn(reviewWardableRetry);
  // Page-level late-reply guard (session + clinical epochs, mount, generation).
  const pageGuard = useRequestGuard("bed-board");
  const [retryReview, setRetryReview] = useState<{ id: string; review: WardableRetryReview; t: RequestTicket } | null>(null);
  const reviewMutation = useMutation({
    mutationFn: (v: { id: string; t: RequestTicket }) => reviewRetry({ data: { partner_patient_id: v.id } }),
    onSuccess: (review, v) => {
      if (pageGuard.isCurrent(v.t)) setRetryReview({ id: v.id, review, t: v.t });
    },
    onError: (_e, v) => {
      if (pageGuard.isCurrent(v.t)) toast.error("Could not check ICU Handover Hub — nothing was sent");
    },
  });
  const startReview = (id: string) => reviewMutation.mutate({ id, t: pageGuard.begin("wardable-review") });
  const retryMutation = useMutation({
    // Only the signed token of the review on screen is sent — it binds the
    // patient, the local revision/value and the Hub state that were shown.
    mutationFn: (v: { review_token: string; id: string; t: RequestTicket }) => retrySync({ data: { review_token: v.review_token } }),
    onSuccess: (p, v) => {
      if (pageGuard.isCurrent(v.t)) reportPartner(p, "Wardable state");
    },
    onError: (_e, v) => {
      if (pageGuard.isCurrent(v.t)) toast.error("Could not send the reviewed update to ICU Handover Hub");
    },
    onSettled: (_d, _e, v) => {
      if (!pageGuard.isCurrent(v.t)) return;
      setRetryReview(null);
      void qc.invalidateQueries({ queryKey: ["patient-wardable-status"] });
      void refetch();
    },
  });

  const wardableMutation = useMutation({
    mutationFn: (input: { partner_patient_id: string; wardable: boolean }): Promise<SetWardableResult> =>
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
            ...(existing ?? {
              desired_revision: "0",
              partner_sync_checked_at: null,
              partner_synced_revision: null,
            }),
            partner_patient_id: input.partner_patient_id,
            wardable: input.wardable,
            wardable_at: input.wardable
              ? existing?.wardable && existing.wardable_at
                ? existing.wardable_at
                : now
              : null,
            discharged_at: null,
            updated_at: now,
            partner_sync_status: "pending",
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
    onSuccess: (r, input) => reportPartner(r.partner, input.wardable ? "Marked wardable" : "Wardable cleared"),
    onSettled: () => {
      // Invalidate (not refetch) so every observer of this key — other
      // panels and other tabs — also picks the change up.
      void qc.invalidateQueries({ queryKey: ["patient-wardable-status"] });
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
            desired_revision: "0",
            partner_sync_status: null,
            partner_sync_checked_at: null,
            partner_synced_revision: null,
            ...(existing ?? {}),
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
      toast.error(err instanceof Error ? err.message : "Could not record discharge time");
    },
    onSuccess: (_r, input) => {
      if (input.undo) toast.success("Recorded discharge time cleared");
      else
        toast.success("Discharge time recorded here", {
          description:
            "Timing only. The bed stays occupied until the patient is discharged in ICU Handover Hub.",
        });
    },
    onSettled: () => {
      // Invalidate (not refetch) so every observer of this key — other
      // panels and other tabs — also picks the change up.
      void qc.invalidateQueries({ queryKey: ["patient-wardable-status"] });
    },
  });

  const handleDischarge = (occupantId: string, undo: boolean) => {
    dischargeMutation.mutate({ partner_patient_id: occupantId, undo });
  };

  const arrivedFromSource =
    search.source_referral_id || search.source_postop_booking_id;
  const fetchSourceContext = useServerFn(getAdmissionSourceContext);
  const sourceContext = useQuery({
    queryKey: [
      "admission-source-context",
      search.source_referral_id ?? null,
      search.source_postop_booking_id ?? null,
    ],
    queryFn: () =>
      fetchSourceContext({
        data: search.source_referral_id
          ? { kind: "referral", id: search.source_referral_id }
          : { kind: "postop", id: search.source_postop_booking_id! },
      }),
    enabled: !!arrivedFromSource,
    staleTime: 60_000,
    retry: false,
  });
  const clearSource = () =>
    navigate({
      search: {
        focus_shift: search.focus_shift,
        focus_level: search.focus_level,
      },
      replace: true,
    });

  // Legacy links (pre-2026-11) put the hospital number / consultant in the
  // query string. Rewrite the URL immediately so they don't linger in
  // history; the identifiers are never read.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (hasLegacyIdentifierParams(params)) {
      navigate({
        search: {
          focus_shift: search.focus_shift,
          focus_level: search.focus_level,
          source_referral_id: search.source_referral_id,
          source_postop_booking_id: search.source_postop_booking_id,
          source_label: search.source_label,
        },
        replace: true,
      });
    }
    // Run once on arrival; `search` is already the validated value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate]);

  // Keep the last good board on screen through a failed refresh, but label
  // it as not current.
  const lastOk = board.lastOk;
  const partnerFailure = board.latestFailure;
  // A denial clears the board: drop the open patient editor and any review
  // with it (the shared clinical gate also unmounts this page).
  useEffect(() => {
    if (!lastOk) {
      setSelected(null);
      setRetryReview(null);
    }
  }, [lastOk]);
  const partnerError = partnerFailure ? failureText({ latestFailure: partnerFailure }) : null;
  const partnerOutage = partnerFailure?.partner_outage === true;
  const physical = capacity.derivation.physical;

  useEffect(() => {
    // No local Realtime subscription: the partner data is fetched over HTTP,
    // and their DB is not in our Supabase project. The polling above is the
    // only refresh mechanism.
    return () => {
      qc.cancelQueries({ queryKey: QK });
    };
  }, [qc]);

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto" data-density={density}>
      <div className="mb-4 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Bed board</h1>
          <p className="text-sm text-muted-foreground flex flex-wrap items-center gap-x-1">
            <span>Snapshot from ICU Handover Hub ·</span>
            <CapacityFreshness view={capacity} compact />
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Button
            variant="outline"
            size="sm"
            onClick={toggleDensity}
            className="gap-1"
            aria-label={`Switch to ${density === "comfortable" ? "compact" : "comfortable"} card density`}
            title={`Switch to ${density === "comfortable" ? "compact" : "comfortable"} density`}
          >
            {density === "comfortable" ? (
              <Rows2 className="w-4 h-4" aria-hidden="true" />
            ) : (
              <Rows3 className="w-4 h-4" aria-hidden="true" />
            )}
            <span className="hidden sm:inline">
              {density === "comfortable" ? "Compact" : "Comfortable"}
            </span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => capacity.refresh()}
            disabled={isFetching}
            className="gap-1 min-h-9"
            aria-label={isFetching ? "Refreshing bed board" : "Refresh bed board"}
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
            <span className="font-medium">
              {search.source_label ?? (search.source_referral_id ? "referral" : "post-op booking")}
            </span>
            {sourceContext.data?.ok && sourceContext.data.patient_initials ? (
              <>
                {" · "}
                <span className="font-mono">{sourceContext.data.patient_initials}</span>
              </>
            ) : null}
            {sourceContext.data && !sourceContext.data.ok ? (
              <span className="text-muted-foreground"> (details not available to your account)</span>
            ) : null}
            . Admissions are now recorded in{" "}
            <span className="font-medium">ICU Handover Hub</span>; place the
            patient there and the bed will appear here on the next refresh.
          </div>
          <button
            type="button"
            className="text-xs min-h-8 px-1 text-muted-foreground hover:text-foreground underline underline-offset-2"
            onClick={clearSource}
            aria-label="Dismiss admission context"
          >
            Dismiss
          </button>
        </div>
      )}

      {lastOk && physical && (() => {
        const allOccupants = [
          ...lastOk.bed_board
            .map((b) => b.occupant)
            .filter((o): o is PartnerOccupant => o !== null),
          ...lastOk.unassigned,
        ];
        const levelMap = new Map<string, AcuityLevel>();
        for (const [k, v] of acuityMap) if (v.level != null) levelMap.set(k, v.level);
        const { counts, unscored, mean } = computeUnitAcuity(
          allOccupants.map((o) => o.id),
          levelMap,
        );

        return (
          <>
            <div
              className="flex flex-wrap items-center gap-2 mb-3"
              role="status"
              aria-label="Unit capacity"
            >
              <StatBlock label={`${lastOk.unit} beds`} value={physical.total} tone="muted" />
              <StatBlock
                label="Occupied"
                value={physical.occupied}
                tone={physical.vacant === 0 ? "bad" : physical.vacant <= 1 ? "warn" : capacity.freshness === "current" ? "ok" : "muted"}
              />
              <StatBlock
                label={capacity.freshness === "current" ? "Free" : "Free (not current)"}
                value={physical.vacant}
                tone={physical.vacant === 0 ? "bad" : physical.vacant <= 1 ? "warn" : capacity.freshness === "current" ? "ok" : "muted"}
              />
              {physical.withheld > 0 && (
                <Badge variant="outline" className="gap-1">
                  <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
                  {physical.withheld} occupied · details withheld
                </Badge>
              )}
              {physical.unassigned > 0 && (
                <Badge variant="outline" className="gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                  {physical.unassigned} awaiting a bed
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
              view={capacity}
              focusShift={search.focus_shift}
              focusLevel={search.focus_level}
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
            {partnerError}
          </div>
          <div className="text-xs mt-1 break-words">
            {partnerFailure?.forbidden
              ? "Ask an administrator to grant a clinical role if you need the bed board."
              : partnerOutage
                ? "The partner service is down or unreachable. The bed board retries every 20 seconds and when you return to this tab."
                : partnerFailure?.indeterminate
                  ? "The Hub's response could not be trusted, so nothing new is shown. It retries every 20 seconds."
                  : partnerFailure?.error}
          </div>
          {lastOk && (
            <div className="text-xs mt-1 font-medium">
              Showing the last successful snapshot from {formatUnitTime(capacity.lastSuccessAt, capacity.now)} (
              {formatUpdated(capacity.lastSuccessAt)}) — NOT current.
            </div>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2 min-h-9"
            onClick={() => capacity.refresh()}
            disabled={isFetching}
          >
            <RefreshCcw className={`w-4 h-4 mr-1 ${isFetching ? "motion-safe:animate-spin" : ""}`} aria-hidden="true" />
            Try again
          </Button>
        </div>
      )}

      {isLoading && !lastOk && !partnerFailure && (
        <BedGridSkeleton />
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
                const endOfLifePendingId =
                  endOfLifeMutation.isPending &&
                  (endOfLifeMutation.variables as { partner_patient_id?: string } | undefined)
                    ?.partner_patient_id;
                const scanTransferPendingId =
                  scanTransferMutation.isPending &&
                  (scanTransferMutation.variables as { partner_patient_id?: string } | undefined)
                    ?.partner_patient_id;
                return (
                  <BedCard
                    // BedCard is a hook-free dispatcher, so the same bed can
                    // change between empty / withheld / occupied safely.
                    key={slot.bed}
                    slot={slot}
                    level={a?.level ?? undefined}
                    hubSync={
                      slot.occupant
                        ? wardableMismatch(w, slot.occupant.wardable)
                        : undefined
                    }
                    hubSyncPending={
                      slot.occupant != null &&
                      ((reviewMutation.isPending && reviewMutation.variables?.id === slot.occupant.id) ||
                        (retryMutation.isPending && retryMutation.variables?.id === slot.occupant.id))
                    }
                    onRetryHubSync={startReview}
                    hubPatientUrl={slot.occupant ? hubPatientUrl(slot.occupant.id) : null}
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
                    endOfLife={
                      slot.occupant?.id != null &&
                      endOfLifeSet.has(slot.occupant.id)
                    }
                    endOfLifePending={
                      slot.occupant?.id != null &&
                      endOfLifePendingId === slot.occupant.id
                    }
                    onToggleEndOfLife={handleToggleEndOfLife}
                    needsScanTransfer={
                      slot.occupant?.id != null &&
                      scanTransferSet.has(slot.occupant.id)
                    }
                    scanTransferPending={
                      slot.occupant?.id != null &&
                      scanTransferPendingId === slot.occupant.id
                    }
                    onToggleScanTransfer={handleToggleScanTransfer}
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
                    isolationPending={

                      slot.occupant?.id != null &&
                      isolationMutation.isPending &&
                      (isolationMutation.variables as { partner_patient_id?: string } | undefined)
                        ?.partner_patient_id === slot.occupant.id
                    }
                    onCycleIsolation={handleCycleIsolation}

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

          <section>
            <Collapsible defaultOpen={false}>
              <CollapsibleTrigger className="group flex items-center justify-between w-full text-left rounded-md border px-3 py-2 hover:bg-accent/40 transition">
                <h2 className="text-sm font-semibold text-muted-foreground flex items-center gap-1">
                  <HelpCircle className="w-3.5 h-3.5" aria-hidden="true" />
                  Bed board symbols
                </h2>
                <ChevronDown
                  className="w-4 h-4 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180"
                  aria-hidden="true"
                />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-xs pt-2">
                  <div className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30">
                    <Biohazard className="w-3.5 h-3.5" aria-hidden="true" />
                    <span className="font-medium">Contact</span>
                    <span className="text-muted-foreground">— contact isolation</span>
                  </div>
                  <div className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30">
                    <Biohazard className="w-3.5 h-3.5" aria-hidden="true" />
                    <span className="font-medium">Droplet</span>
                    <span className="text-muted-foreground">— droplet isolation</span>
                  </div>
                  <div className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30">
                    <Biohazard className="w-3.5 h-3.5" aria-hidden="true" />
                    <span className="font-medium">Airborne</span>
                    <span className="text-muted-foreground">— airborne isolation</span>
                  </div>
                  <div className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/30">
                    <Stethoscope className="w-3.5 h-3.5" aria-hidden="true" />
                    <span className="font-medium">Trache</span>
                    <span className="text-muted-foreground">— tracheostomy in situ</span>
                  </div>
                  <div className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/30">
                    <span className="font-medium">1:1</span>
                    <span className="text-muted-foreground">— requires 1:1 nursing</span>
                  </div>
                  <div className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/40">
                    <Swords className="w-3.5 h-3.5" aria-hidden="true" />
                    <span className="font-medium">Violence risk</span>
                    <span className="text-muted-foreground">— potentially violent/aggressive</span>
                  </div>
                  <div className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 bg-violet-500/15 text-violet-700 dark:text-violet-400 border-violet-500/40">
                    <Heart className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
                    <span className="font-medium">End of life</span>
                    <span className="text-muted-foreground">— receiving end-of-life care</span>
                  </div>
                  <div className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 bg-indigo-500/15 text-indigo-700 dark:text-indigo-400 border-indigo-500/40">
                    <ScanLine className="w-3.5 h-3.5" aria-hidden="true" />
                    <span className="font-medium">For scan</span>
                    <span className="text-muted-foreground">— needs transfer for a scan</span>
                  </div>
                  <div className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border-emerald-500/40">
                    <span className="font-medium">✓ Wardable</span>
                    <span className="text-muted-foreground">— ready for discharge to ward</span>
                  </div>
                  <div className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 border-dashed text-muted-foreground">
                    <span className="font-medium">Dashed outline</span>
                    <span>— not active; click to toggle</span>
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
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
                      Occupancy is read live from{" "}
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

      <AlertDialog open={!!retryReview} onOpenChange={(v) => !v && setRetryReview(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Review the ICU Handover Hub update</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                {retryReview?.review.local ? (
                  <>
                    <div>
                      Saved here (latest change):{" "}
                      <strong>{retryReview.review.local.wardable ? "Wardable" : "Not wardable"}</strong>
                    </div>
                    <div>
                      ICU Handover Hub now:{" "}
                      <strong>
                        {retryReview.review.hub.state === "ok"
                          ? retryReview.review.hub.wardable === null
                            ? "not shown by the Hub"
                            : retryReview.review.hub.wardable
                              ? "Wardable"
                              : "Not wardable"
                          : retryReview.review.hub.state === "not_shared"
                            ? "patient no longer shared"
                            : "could not be checked"}
                      </strong>
                    </div>
                    {retryReview.review.confirm?.mode === "new_revision" && (
                      <div className="text-xs">
                        ICU Handover Hub already applied this change and it was then changed directly in the Hub. Confirming sends it again as a new change.
                      </div>
                    )}
                    {!retryReview.review.confirm && retryReview.review.hub.state === "ok" && (
                      <div className="text-xs">Nothing needs sending — the Hub already shows this.</div>
                    )}
                    {!retryReview.review.confirm && retryReview.review.hub.state !== "ok" && (
                      <div className="text-xs">The Hub could not be checked, so nothing can be sent. Try again later.</div>
                    )}
                    <div className="text-xs text-muted-foreground">
                      Exactly what is shown here is sent. If either side changes before you confirm, nothing is overwritten and you will be asked to review again.
                    </div>
                  </>
                ) : (
                  <div>There is no saved wardable change to send.</div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {retryReview?.review.local && retryReview.review.confirm && (
              <AlertDialogAction
                disabled={retryMutation.isPending}
                onClick={() =>
                  retryReview.review.confirm &&
                  retryMutation.mutate({
                    review_token: retryReview.review.confirm.token,
                    id: retryReview.id,
                    t: pageGuard.begin("wardable-confirm"),
                  })
                }
              >
                Send “{retryReview.review.local.wardable ? "Wardable" : "Not wardable"}” to Hub
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {lastOk && selected && (
      <EditOccupantDialog
        key={`${selected.id}|${search.source_referral_id ?? ""}`}
        occupant={selected}
        currentLevel={selected ? acuityMap.get(selected.id)?.level ?? null : null}
        currentOneToOne={selected ? acuityMap.get(selected.id)?.one_to_one === true : false}
        currentAcuityRevision={selected ? acuityMap.get(selected.id)?.updated_at ?? null : null}
        sourceReferralId={search.source_referral_id ?? null}
        onClose={() => setSelected(null)}
        onSaved={(updated) => {
          setSelected(updated);
          void refetch();
        }}
        onAcuityChanged={() => void qc.invalidateQueries({ queryKey: ACUITY_QK })}
        onConflictReload={() => void refetch()}
      />
      )}

    </div>
  );
}
