import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, useMemo, useCallback } from "react";
import { useServerFn } from "@tanstack/react-start";
import { queryOptions, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Plus, Trash2 } from "lucide-react";
import {
  getUnreadReferralCounts,
  listDeletedReferrals,
  listReferralsForList,
  restoreReferral,
} from "@/lib/referrals.functions";

import type { AdmissionUrgency } from "@/lib/admission-urgency";
import { toast } from "sonner";

import {
  computeTopWards,
  filterReferrals,
  sortByTimer,
  type DateKey,
  type PediatricKey,
  type Referral,
  type StatusKey,
} from "@/lib/referrals-list-utils";
import { ReferralsDrilldownBadges } from "@/components/referrals/referrals-drilldown-badges";
import { ReferralsFilterToolbar } from "@/components/referrals/referrals-filter-toolbar";
import { ReferralsDeletedPanel } from "@/components/referrals/referrals-deleted-panel";
import { ReferralsRows } from "@/components/referrals/referrals-rows";
import { MiniCapacityLink } from "@/components/bed-board/mini-capacity-link";
import { QuickFilterChips } from "@/components/referrals/quick-filter-chips";
import { CapacityBadge } from "@/components/referrals/capacity-badge";

import { applyQuickFilter, matchesQuickFilter, type QuickFilterKey } from "@/lib/quick-filters";
import { ClinicalAccessGate } from "@/components/clinical-access-gate";
import { ReferralRouteError } from "@/components/referral-route-error";

// Cache key for the live referrals list. Kept as a stable tuple so the
// realtime subscription can invalidate it without importing the options.
export const REFERRALS_LIST_QUERY_KEY = ["referrals", "list"] as const;
export const REFERRALS_UNREAD_COUNTS_QUERY_KEY = ["referrals", "unreadCounts"] as const;

const referralsListQueryOptions = queryOptions({
  queryKey: REFERRALS_LIST_QUERY_KEY,
  // Server fn invocations work identically from loader and component.
  queryFn: () => listReferralsForList(),
  // Realtime drives invalidation; a small staleTime dedupes bursts.
  staleTime: 5_000,
});

const unreadCountsQueryOptions = queryOptions({
  queryKey: REFERRALS_UNREAD_COUNTS_QUERY_KEY,
  queryFn: () => getUnreadReferralCounts(),
  staleTime: 5_000,
});


function ReferralsListPending() {
  return (
    <div className="p-4 sm:p-6 space-y-3" aria-busy="true" aria-label="Loading referrals">
      <div className="h-8 w-48 rounded bg-muted motion-safe:animate-pulse" />
      <div className="flex gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-8 w-20 rounded bg-muted motion-safe:animate-pulse" />
        ))}
      </div>
      <div className="space-y-2 pt-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-16 rounded-md border bg-muted/40 motion-safe:animate-pulse" />
        ))}
      </div>
    </div>
  );
}

function ReferralsListError({ error }: { error: Error }) {
  return <ReferralRouteError error={error} label="Referrals" />;
}

export const Route = createFileRoute("/_authenticated/")({
  head: () => ({
    meta: [
      { title: "Referrals — SDH Critical Care" },
      { name: "description", content: "Live list of critical care referrals at Salisbury District Hospital." },
    ],
  }),
  validateSearch: (search: Record<string, unknown>) => ({
    specialty: typeof search.specialty === "string" ? search.specialty : undefined,
    from: typeof search.from === "string" ? search.from : undefined, // yyyy-MM-dd inclusive
    to: typeof search.to === "string" ? search.to : undefined,       // yyyy-MM-dd inclusive
    quick: typeof search.quick === "string" ? (search.quick as QuickFilterKey) : undefined,
  }),
  // Prime the referrals list cache before the component mounts. The parent
  // `_authenticated` layout is `ssr: false`, so this runs client-side after
  // the auth gate — bearer middleware is attached and the fetch is authorised.
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(referralsListQueryOptions),
      context.queryClient.ensureQueryData(unreadCountsQueryOptions),
    ]),

  pendingComponent: ReferralsListPending,
  errorComponent: ReferralsListError,
  component: ReferralsList,
});

function ReferralsList() {
  const search = Route.useSearch();
  // Data is primed by the route loader and read via useSuspenseQuery, so
  // there's no local "loading" state on initial render — the suspense
  // boundary shows `pendingComponent` until data resolves. Background
  // refetches (from realtime invalidation) are silent by design.
  const { data: rowsData } = useSuspenseQuery(referralsListQueryOptions);
  const { data: unreadByReferral } = useSuspenseQuery(unreadCountsQueryOptions);
  const rows = rowsData as Referral[];
  const queryClient = useQueryClient();


  const [hospSearch, setHospSearch] = useState("");
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusKey>("all");
  const [urgencyFilter, setUrgencyFilter] = useState<"all" | AdmissionUrgency>("all");
  const [locFilter, setLocFilter] = useState<string>("all");
  const [dateFilter, setDateFilter] = useState<DateKey>("all");
  const [pediatricFilter, setPediatricFilter] = useState<PediatricKey>("all");
  const [showDeleted, setShowDeleted] = useState(false);
  const [deletedRows, setDeletedRows] = useState<Referral[]>([]);
  const [deletedLoading, setDeletedLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [timerSort, setTimerSort] = useState<"none" | "desc" | "asc">("none");
  const [sortTick, setSortTick] = useState(0);

  // Re-sort every 30 s when timer sort is on so elapsed timings stay
  // ordered without waiting for the next user interaction.
  useEffect(() => {
    if (timerSort === "none") return;
    const id = setInterval(() => setSortTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, [timerSort]);

  const fetchDeleted = useServerFn(listDeletedReferrals);
  const restoreFn = useServerFn(restoreReferral);

  const loadDeleted = useCallback(async () => {
    setDeletedLoading(true);
    try {
      const data = await fetchDeleted();
      setDeletedRows((data ?? []) as Referral[]);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to load deleted referrals");
    } finally {
      setDeletedLoading(false);
    }
  }, [fetchDeleted]);

  useEffect(() => {
    if (showDeleted) loadDeleted();
  }, [showDeleted, loadDeleted]);

  const onRestore = async (id: string) => {
    setRestoringId(id);
    try {
      await restoreFn({ data: { id } });
      toast.success("Referral restored");
      setDeletedRows((cur) => cur.filter((r) => r.id !== id));
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to restore referral");
    } finally {
      setRestoringId(null);
    }
  };

  // Realtime payloads contain encrypted fields, so we can't apply them
  // in-place. Use them purely as an invalidation signal — TanStack Query
  // will refetch (deduped by `staleTime` on the options) and swap the data.
  useEffect(() => {
    const ch = supabase
      .channel("referrals-list")
      .on("postgres_changes", { event: "*", schema: "public", table: "referrals" }, () => {
        queryClient.invalidateQueries({ queryKey: REFERRALS_LIST_QUERY_KEY });
      })
      // Unread badge stays in sync as notifications are inserted (new
      // fanout) or marked read (via /referrals/{id} → logReferralView).
      // RLS scopes rows to this user, so we get exactly our own events.
      .on("postgres_changes", { event: "*", schema: "public", table: "notifications" }, () => {
        queryClient.invalidateQueries({ queryKey: REFERRALS_UNREAD_COUNTS_QUERY_KEY });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [queryClient]);


  const topWards = useMemo(() => computeTopWards(rows), [rows]);

  const baseFiltered = useMemo(
    () =>
      filterReferrals(rows, {
        hospSearch,
        q,
        statusFilter,
        urgencyFilter,
        locFilter,
        dateFilter,
        pediatricFilter,
        drilldown: { specialty: search.specialty, from: search.from, to: search.to },
      }),
    [rows, hospSearch, q, statusFilter, urgencyFilter, locFilter, dateFilter, pediatricFilter, search.specialty, search.from, search.to],
  );

  const navigate = useNavigate({ from: "/" });
  const quick: QuickFilterKey = search.quick ?? "all";

  const quickCounts = useMemo(() => ({
    all: baseFiltered.length,
    awaiting_review: baseFiltered.filter((r) => matchesQuickFilter(r, "awaiting_review")).length,
    awaiting_bed: baseFiltered.filter((r) => matchesQuickFilter(r, "awaiting_bed")).length,
    accepted_not_arrived: baseFiltered.filter((r) => matchesQuickFilter(r, "accepted_not_arrived")).length,
    discussed_pending: baseFiltered.filter((r) => matchesQuickFilter(r, "discussed_pending")).length,
  }), [baseFiltered]);

  const filtered = useMemo(() => applyQuickFilter(baseFiltered, quick), [baseFiltered, quick]);

  const displayed = useMemo(
    () => sortByTimer(filtered, timerSort, Date.now()),
    // sortTick triggers re-sort as time advances
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, timerSort, sortTick],
  );

  return (
    <ClinicalAccessGate>
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Referrals</h1>
          <p className="text-sm text-muted-foreground">{rows.length} total · live updating</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <CapacityBadge />

          <Button
            variant={showDeleted ? "default" : "outline"}
            size="sm"
            onClick={() => setShowDeleted((v) => !v)}
          >
            <Trash2 className="w-4 h-4 mr-1" aria-hidden="true" />
            {showDeleted ? "Hide" : "Recently deleted"}
          </Button>
          <Button asChild>
            <Link to="/referrals/new"><Plus className="w-4 h-4 mr-1" aria-hidden="true" /> New referral</Link>
          </Button>
        </div>
      </div>

      <ReferralsDrilldownBadges
        specialty={search.specialty}
        from={search.from}
        to={search.to}
      />

      <div className="mb-4">
        <MiniCapacityLink />
      </div>


      {showDeleted && (
        <ReferralsDeletedPanel
          rows={deletedRows}
          loading={deletedLoading}
          restoringId={restoringId}
          onRestore={onRestore}
        />
      )}

      <QuickFilterChips
        value={quick}
        counts={quickCounts}
        onChange={(k) => navigate({ search: ((prev: Record<string, unknown>) => ({ ...prev, quick: k === "all" ? undefined : k })) as never })}
      />

      <ReferralsFilterToolbar
        hospSearch={hospSearch}
        onHospSearchChange={setHospSearch}
        q={q}
        onQChange={setQ}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        dateFilter={dateFilter}
        onDateFilterChange={setDateFilter}
        urgencyFilter={urgencyFilter}
        onUrgencyFilterChange={setUrgencyFilter}
        locFilter={locFilter}
        onLocFilterChange={setLocFilter}
        topWards={topWards}
        pediatricFilter={pediatricFilter}
        onPediatricFilterChange={setPediatricFilter}
      />

      <ReferralsRows
        rows={displayed}
        loading={false}
        timerSort={timerSort}
        onToggleTimerSort={() =>
          setTimerSort((s) => (s === "none" ? "desc" : s === "desc" ? "asc" : "none"))
        }
        unreadByReferral={unreadByReferral as Record<string, number>}
      />

    </div>
    </ClinicalAccessGate>
  );
}
