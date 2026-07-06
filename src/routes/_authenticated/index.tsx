import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, useMemo, useCallback } from "react";
import { useServerFn } from "@tanstack/react-start";
import { queryOptions, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Plus, Search, RotateCcw, Trash2, MapPin, Baby, HelpCircle } from "lucide-react";
import type { Tables } from "@/integrations/supabase/types";
import { format, formatDistanceToNow, parseISO } from "date-fns";
import { tzTooltip } from "@/lib/format-timestamp";
import { listDeletedReferrals, listReferralsForList, restoreReferral, RESTORE_WINDOW_DAYS, type DecryptedReferral } from "@/lib/referrals.functions";
import { ADMISSION_URGENCY_LABELS, ADMISSION_URGENCY_BADGE, ADMISSION_URGENCY_OPTIONS, type AdmissionUrgency } from "@/lib/admission-urgency";
import { toast } from "sonner";

type Referral = Tables<"referrals"> & DecryptedReferral;

// Cache key for the live referrals list. Kept as a stable tuple so the
// realtime subscription can invalidate it without importing the options.
export const REFERRALS_LIST_QUERY_KEY = ["referrals", "list"] as const;

const referralsListQueryOptions = queryOptions({
  queryKey: REFERRALS_LIST_QUERY_KEY,
  // Server fn invocations work identically from loader and component.
  queryFn: () => listReferralsForList(),
  // Realtime drives invalidation; a small staleTime dedupes bursts.
  staleTime: 5_000,
});



function formatElapsed(ms: number): string {
  if (ms < 0) ms = 0;
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function getTimerElapsedMs(r: Referral, now: number): number | null {
  if (r.status === "pending") return now - new Date(r.referral_received_at).getTime();
  if (r.status === "accepted" || r.status === "admitted") {
    const startSrc = r.decision_at ?? r.updated_at;
    if (!startSrc) return null;
    const end = r.arrived_on_unit_at ? new Date(r.arrived_on_unit_at).getTime() : now;
    return end - new Date(startSrc).getTime();
  }
  return null;
}

function getTimerInfo(r: Referral, now: number): { label: string; value: string; tone: string } | null {
  if (r.status === "pending") {
    const start = new Date(r.referral_received_at).getTime();
    return { label: "Waiting", value: formatElapsed(now - start), tone: "text-warning-foreground" };
  }
  if (r.status === "accepted" || r.status === "admitted") {
    const startSrc = r.decision_at ?? r.updated_at;
    if (!startSrc) return null;
    const start = new Date(startSrc).getTime();
    const end = r.arrived_on_unit_at ? new Date(r.arrived_on_unit_at).getTime() : now;
    return {
      label: r.arrived_on_unit_at ? "Time to admission" : "Time waiting for admission",
      value: formatElapsed(end - start),
      tone: "text-success",
    };
  }
  return null;
}

function ReferralTimer({ r }: { r: Referral }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);
  const info = getTimerInfo(r, now);
  if (!info) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex flex-col leading-tight">
      <span className={`font-mono text-sm tabular-nums ${info.tone}`}>{info.value}</span>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{info.label}</span>
    </div>
  );
}


function ReferralsListPending() {
  return (
    <div className="p-6 text-sm text-muted-foreground">Loading referrals…</div>
  );
}

function ReferralsListError({ error }: { error: Error }) {
  return (
    <div className="p-6 text-sm text-destructive" role="alert">
      Failed to load referrals: {error.message}
    </div>
  );
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
  }),
  // Prime the referrals list cache before the component mounts. The parent
  // `_authenticated` layout is `ssr: false`, so this runs client-side after
  // the auth gate — bearer middleware is attached and the fetch is authorised.
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(referralsListQueryOptions),
  pendingComponent: ReferralsListPending,
  errorComponent: ReferralsListError,
  component: ReferralsList,
});


const statusStyles: Record<string, string> = {
  pending: "bg-warning/15 text-warning-foreground border-warning/30",
  accepted: "bg-success/15 text-success border-success/30",
  admitted: "bg-success/15 text-success border-success/30",
  declined: "bg-destructive/10 text-destructive border-destructive/30",
};

const rowBgStyles: Record<string, string> = {
  pending: "bg-warning/[0.08]",
  accepted: "bg-success/[0.08]",
  admitted: "bg-success/[0.08]",
  declined: "bg-destructive/[0.06]",
};

function ReferralsList() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  // Data is primed by the route loader and read via useSuspenseQuery, so
  // there's no local "loading" state on initial render — the suspense
  // boundary shows `pendingComponent` until data resolves. Background
  // refetches (from realtime invalidation) are silent by design.
  const { data: rowsData } = useSuspenseQuery(referralsListQueryOptions);
  const rows = rowsData as Referral[];
  const loading = false;
  const queryClient = useQueryClient();

  const [hospSearch, setHospSearch] = useState("");
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [urgencyFilter, setUrgencyFilter] = useState<"all" | AdmissionUrgency>("all");
  const [locFilter, setLocFilter] = useState<string>("all");
  const [dateFilter, setDateFilter] = useState<"all" | "today" | "yesterday" | "7d" | "30d">("all");
  const [pediatricFilter, setPediatricFilter] = useState<"all" | "pediatric">("all");
  const [showDeleted, setShowDeleted] = useState(false);
  const [deletedRows, setDeletedRows] = useState<Referral[]>([]);
  const [deletedLoading, setDeletedLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [timerSort, setTimerSort] = useState<"none" | "desc" | "asc">("none");
  const [sortTick, setSortTick] = useState(0);
  // Clinician names for the "Taken by" column are joined server-side into
  // each row's `creator_name` field — no client fetch needed.
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
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [queryClient]);







  const topWards = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      if (!r.current_ward) continue;
      counts.set(r.current_ward, (counts.get(r.current_ward) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([ward]) => ward);
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hospNeedle = hospSearch.trim().toLowerCase();
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    let fromTs: number | null = null;
    let toTs: number | null = null;
    if (dateFilter === "today") fromTs = startOfToday;
    else if (dateFilter === "yesterday") { fromTs = startOfToday - 86400000; toTs = startOfToday; }
    else if (dateFilter === "7d") fromTs = now.getTime() - 7 * 86400000;
    else if (dateFilter === "30d") fromTs = now.getTime() - 30 * 86400000;

    // Drill-down date range from search params (yyyy-MM-dd, inclusive on both ends).
    // Overrides the quick date buttons above so a chart-click narrows precisely.
    if (search.from) {
      const t = Date.parse(`${search.from}T00:00:00`);
      if (!Number.isNaN(t)) fromTs = t;
    }
    if (search.to) {
      const t = Date.parse(`${search.to}T00:00:00`);
      if (!Number.isNaN(t)) toTs = t + 86400000; // exclusive upper bound
    }

    const specialtyNeedle = search.specialty?.trim().toLowerCase() ?? "";

    return rows.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (urgencyFilter !== "all" && r.admission_urgency !== urgencyFilter) return false;
      if (locFilter !== "all" && r.current_ward !== locFilter) return false;
      if (specialtyNeedle && (r.referring_specialty ?? "").trim().toLowerCase() !== specialtyNeedle) return false;
      if (pediatricFilter === "pediatric") {
        if (r.age === null || r.age > 16) return false;
      }
      if (fromTs !== null) {
        const t = new Date(r.referral_received_at).getTime();
        if (t < fromTs) return false;
        if (toTs !== null && t >= toTs) return false;
      }
      if (hospNeedle) {
        const hn = (r.hospital_number ?? "").toLowerCase();
        if (!hn.includes(hospNeedle)) return false;
      }
      if (!needle) return true;
      return [r.hospital_number, r.current_ward, r.current_bed, r.referring_specialty, r.reason_for_referral]
        .filter(Boolean)
        .some((v) => v!.toString().toLowerCase().includes(needle));
    });
  }, [rows, q, hospSearch, statusFilter, urgencyFilter, locFilter, dateFilter, search.specialty, search.from, search.to, pediatricFilter]);

  const displayed = useMemo(() => {
    if (timerSort === "none") return filtered;
    const now = Date.now();
    const dir = timerSort === "desc" ? -1 : 1;
    return [...filtered].sort((a, b) => {
      const ea = getTimerElapsedMs(a, now);
      const eb = getTimerElapsedMs(b, now);
      // Rows without an active timer always sort to the bottom.
      if (ea === null && eb === null) return 0;
      if (ea === null) return 1;
      if (eb === null) return -1;
      return (ea - eb) * dir;
    });
    // sortTick triggers re-sort as time advances
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, timerSort, sortTick]);

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Referrals</h1>
          <p className="text-sm text-muted-foreground">{rows.length} total · live updating</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant={showDeleted ? "default" : "outline"}
            size="sm"
            onClick={() => setShowDeleted((v) => !v)}
          >
            <Trash2 className="w-4 h-4 mr-1" />
            {showDeleted ? "Hide" : "Recently deleted"}
          </Button>
          <Button asChild>
            <Link to="/referrals/new"><Plus className="w-4 h-4 mr-1" /> New referral</Link>
          </Button>
        </div>
      </div>

      {(search.specialty || search.from || search.to) && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
          <span className="text-xs uppercase text-muted-foreground">Drill-down</span>
          {search.specialty && (
            <Badge variant="secondary" className="gap-1">
              Specialty: {search.specialty}
              <button
                type="button"
                aria-label="Clear specialty filter"
                className="ml-1 opacity-70 hover:opacity-100"
                onClick={() => navigate({ to: "/", search: (p: Record<string, unknown>) => ({ ...p, specialty: undefined }) })}
              >×</button>
            </Badge>
          )}
          {(search.from || search.to) && (
            <Badge variant="secondary" className="gap-1">
            Date: {search.from ? format(parseISO(search.from), "dd/MM/yyyy") : "…"}{search.to && search.to !== search.from ? ` → ${format(parseISO(search.to), "dd/MM/yyyy")}` : ""}
              <button
                type="button"
                aria-label="Clear date filter"
                className="ml-1 opacity-70 hover:opacity-100"
                onClick={() => navigate({ to: "/", search: (p: Record<string, unknown>) => ({ ...p, from: undefined, to: undefined }) })}
              >×</button>
            </Badge>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7"
            onClick={() => navigate({ to: "/", search: {} })}
          >
            Clear all
          </Button>
        </div>
      )}



      {showDeleted && (
        <div className="border rounded-md bg-card overflow-hidden mb-6">
          <div className="px-3 py-2 border-b bg-muted/40 text-sm flex items-center justify-between">
            <span className="font-medium">Recently deleted</span>
            <span className="text-xs text-muted-foreground">
              Restorable within {RESTORE_WINDOW_DAYS} days of deletion
            </span>
          </div>
          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto"><table className="w-full text-sm min-w-[640px]">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2">Deleted</th>
                <th className="text-left px-3 py-2">Hosp. no</th>
                <th className="text-left px-3 py-2">Location</th>
                <th className="text-left px-3 py-2">Specialty</th>
                <th className="text-left px-3 py-2">Reason</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {deletedLoading && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
              )}
              {!deletedLoading && deletedRows.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">No restorable referrals.</td></tr>
              )}
              {deletedRows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                    {r.deleted_at ? `${formatDistanceToNow(new Date(r.deleted_at))} ago` : "—"}
                  </td>
                  <td className="px-3 py-2">{r.hospital_number ?? "—"}</td>
                  <td className="px-3 py-2">{r.current_ward ?? "—"} {r.current_bed ? `· ${r.current_bed}` : ""}</td>
                  <td className="px-3 py-2">{r.referring_specialty ?? "—"}</td>
                  <td className="px-3 py-2 max-w-xs truncate">{r.reason_for_referral ?? "—"}</td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={restoringId === r.id}
                      onClick={() => onRestore(r.id)}
                    >
                      <RotateCcw className="w-3.5 h-3.5 mr-1" />
                      {restoringId === r.id ? "Restoring…" : "Restore"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
          {/* Mobile cards */}
          <div className="md:hidden flex flex-col gap-2 p-3">
            {deletedLoading && (
              <div className="text-center text-muted-foreground py-6">Loading…</div>
            )}
            {!deletedLoading && deletedRows.length === 0 && (
              <div className="text-center text-muted-foreground py-6">No restorable referrals.</div>
            )}
            {deletedRows.map((r) => (
              <div key={r.id} className="border rounded-lg bg-background p-3 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    Deleted {r.deleted_at ? `${formatDistanceToNow(new Date(r.deleted_at))} ago` : "—"}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={restoringId === r.id}
                    onClick={() => onRestore(r.id)}
                  >
                    <RotateCcw className="w-3.5 h-3.5 mr-1" />
                    {restoringId === r.id ? "Restoring…" : "Restore"}
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                  <div>
                    <span className="text-xs text-muted-foreground block">Hosp. no</span>
                    <span className="font-medium">{r.hospital_number ?? "—"}</span>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground block">Specialty</span>
                    <span className="font-medium">{r.referring_specialty ?? "—"}</span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-xs text-muted-foreground block">Location</span>
                    <span className="font-medium">{r.current_ward ?? "—"} {r.current_bed ? `· ${r.current_bed}` : ""}</span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-xs text-muted-foreground block">Reason</span>
                    <span className="font-medium line-clamp-2">{r.reason_for_referral ?? "—"}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}


      <div className="flex flex-wrap gap-2 mb-4">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by hospital number…"
            value={hospSearch}
            onChange={(e) => setHospSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search ward, bed, specialty, reason…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-9"
          />
        </div>
        {(["all", "pending", "accepted", "admitted", "declined"] as const).map((s) => (
          <Button
            key={s}
            size="sm"
            variant={statusFilter === s ? "default" : "outline"}
            onClick={() => setStatusFilter(s)}
            className="capitalize"
          >
            {s}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 mb-4 items-center">
        <span className="text-xs uppercase text-muted-foreground mr-1">Date</span>
        {([
          { k: "all", label: "All time" },
          { k: "today", label: "Today" },
          { k: "yesterday", label: "Yesterday" },
          { k: "7d", label: "Last 7 days" },
          { k: "30d", label: "Last 30 days" },
        ] as const).map(({ k, label }) => (
          <Button
            key={k}
            size="sm"
            variant={dateFilter === k ? "default" : "outline"}
            onClick={() => setDateFilter(k)}
          >
            {label}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 mb-4 items-center">
        <span className="text-xs uppercase text-muted-foreground mr-1">Urgency</span>
        <Button
          size="sm"
          variant={urgencyFilter === "all" ? "default" : "outline"}
          onClick={() => setUrgencyFilter("all")}
        >
          All
        </Button>
        {ADMISSION_URGENCY_OPTIONS.map((o) => (
          <Button
            key={o.value}
            size="sm"
            variant={urgencyFilter === o.value ? "default" : "outline"}
            onClick={() => setUrgencyFilter(o.value)}
          >
            {o.label}
          </Button>
        ))}
      </div>

      {topWards.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4 items-center">
          <span className="text-xs uppercase text-muted-foreground mr-1">Location</span>
          <Button
            size="sm"
            variant={locFilter === "all" ? "default" : "outline"}
            onClick={() => setLocFilter("all")}
          >
            All
          </Button>
          {topWards.map((ward) => (
            <Button
              key={ward}
              size="sm"
              variant={locFilter === ward ? "default" : "outline"}
              onClick={() => setLocFilter(ward)}
            >
              <MapPin className="w-3 h-3 mr-1" />
              {ward}
            </Button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-4 items-center">
        <span className="text-xs uppercase text-muted-foreground mr-1">Age group</span>
        <Button
          size="sm"
          variant={pediatricFilter === "all" ? "default" : "outline"}
          onClick={() => setPediatricFilter("all")}
        >
          All ages
        </Button>
        <Button
          size="sm"
          variant={pediatricFilter === "pediatric" ? "default" : "outline"}
          onClick={() => setPediatricFilter("pediatric")}
        >
          <Baby className="w-3.5 h-3.5 mr-1" />
          Pediatric (≤16)
        </Button>
      </div>


      {/* Desktop table */}
      <div className="hidden md:block border rounded-md bg-card overflow-hidden">
        <div className="overflow-x-auto"><table className="w-full text-sm min-w-[720px]">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2">Received</th>
              <th className="text-left px-3 py-2">Hosp. no</th>
              <th className="text-left px-3 py-2">Age/Sex</th>
              <th className="text-left px-3 py-2">Location</th>
              <th className="text-left px-3 py-2">Specialty</th>
              <th className="text-left px-3 py-2">Reason</th>
              <th className="text-left px-3 py-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 uppercase hover:text-foreground"
                  onClick={() =>
                    setTimerSort((s) => (s === "none" ? "desc" : s === "desc" ? "asc" : "none"))
                  }
                  aria-label="Sort by timer"
                >
                  Timer
                  <span className="text-[10px]">
                    {timerSort === "desc" ? "↓" : timerSort === "asc" ? "↑" : "↕"}
                  </span>
                </button>
              </th>
              <th className="text-left px-3 py-2">Urgency</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">Taken by</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={10} className="px-3 py-8 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {!loading && displayed.length === 0 && (
              <tr><td colSpan={10} className="px-3 py-8 text-center text-muted-foreground">No referrals match.</td></tr>)}
            {displayed.map((r) => (
              <tr
                key={r.id}
                className={`border-t hover:bg-accent/40 cursor-pointer ${rowBgStyles[r.status] ?? ""}`}
                onClick={() => navigate({ to: "/referrals/$id", params: { id: r.id } })}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    navigate({ to: "/referrals/$id", params: { id: r.id } });
                  }
                }}
              >
                <td className="px-3 py-2 whitespace-nowrap" title={tzTooltip(r.referral_received_at)}>
                  {format(new Date(r.referral_received_at), "dd/MM/yyyy HH:mm")}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span>{r.hospital_number ?? "—"}</span>
                    {(r as any).is_test && (
                      <Badge
                        variant="outline"
                        className="border-amber-500/60 text-amber-700 dark:text-amber-300 bg-amber-100/60 dark:bg-amber-900/30 text-[10px] px-1.5 py-0"
                        title="Test/demonstration entry — excluded from analytics"
                      >
                        Test
                      </Badge>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    {r.age !== null && r.age <= 16 && (
                      <span title="Pediatric patient (≤16)">
                        <Baby className="w-4 h-4 text-primary" />
                      </span>
                    )}
                    {r.age === null && (
                      <span
                        title="Age not recorded — cannot be classified as pediatric"
                        className="inline-flex items-center gap-1 rounded border border-amber-500/60 bg-amber-100/60 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 px-1.5 py-0 text-[10px] font-medium"
                      >
                        <HelpCircle className="w-3 h-3" />
                        Age unknown
                      </span>
                    )}
                    <span>{r.age ?? "?"} / {r.sex ?? "?"}</span>
                  </div>

                </td>
                <td className="px-3 py-2">{r.current_ward ?? "—"} {r.current_bed ? `· ${r.current_bed}` : ""}</td>
                <td className="px-3 py-2">{r.referring_specialty ?? "—"}</td>
                <td className="px-3 py-2 max-w-xs truncate">{r.reason_for_referral ?? "—"}</td>
                <td className="px-3 py-2"><ReferralTimer r={r} /></td>
                <td className="px-3 py-2">
                  {r.admission_urgency ? (
                    <Badge variant="outline" className={`whitespace-nowrap ${ADMISSION_URGENCY_BADGE[r.admission_urgency]}`}>
                      {ADMISSION_URGENCY_LABELS[r.admission_urgency]}
                    </Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Badge variant="outline" className={`capitalize ${statusStyles[r.status]}`}>{r.status}</Badge>
                  {r.status === "admitted" && (r as any).accepting_consultant && (
                    <div className="text-xs text-muted-foreground mt-1 whitespace-nowrap">
                      Accepted by {(r as any).accepting_consultant}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {r.creator_name
                    ? r.creator_name
                    : <span className="text-xs text-muted-foreground">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden flex flex-col gap-3">
        {loading && (
          <div className="text-center text-muted-foreground py-8">Loading…</div>
        )}
        {!loading && displayed.length === 0 && (
          <div className="text-center text-muted-foreground py-8">No referrals match.</div>
        )}
        {displayed.map((r) => (
          <div
            key={r.id}
            className={`border rounded-lg p-4 cursor-pointer active:scale-[0.99] transition-transform ${rowBgStyles[r.status] ?? "bg-card"}`}
            onClick={() => navigate({ to: "/referrals/$id", params: { id: r.id } })}
          >
            <div className="flex flex-col gap-2 mb-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground shrink-0" title={tzTooltip(r.referral_received_at)}>
                  {format(new Date(r.referral_received_at), "dd/MM/yyyy HH:mm")}
                </span>
                <div className="flex items-center gap-1.5">
                  {(r as any).is_test && (
                    <Badge
                      variant="outline"
                      className="border-amber-500/60 text-amber-700 dark:text-amber-300 bg-amber-100/60 dark:bg-amber-900/30 text-[10px] px-1.5 py-0"
                      title="Test/demonstration entry — excluded from analytics"
                    >
                      Test
                    </Badge>
                  )}
                  <Badge variant="outline" className={`capitalize text-xs shrink-0 ${statusStyles[r.status]}`}>
                    {r.status}
                  </Badge>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <ReferralTimer r={r} />
                {r.admission_urgency && (
                  <Badge variant="outline" className={`text-xs whitespace-nowrap ${ADMISSION_URGENCY_BADGE[r.admission_urgency]}`}>
                    {ADMISSION_URGENCY_LABELS[r.admission_urgency]}
                  </Badge>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              <div>
                <span className="text-xs text-muted-foreground block">Hospital No</span>
                <span className="font-medium">{r.hospital_number ?? "—"}</span>
              </div>
              <div>
                <span className="text-xs text-muted-foreground block">Age / Sex</span>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {r.age !== null && r.age <= 16 && (
                    <span title="Pediatric patient (≤16)">
                      <Baby className="w-4 h-4 text-primary" />
                    </span>
                  )}
                  <span className="font-medium">{r.age ?? "?"} / {r.sex ?? "?"}</span>
                  {r.age === null && (
                    <span
                      title="Age not recorded — cannot be classified as pediatric"
                      className="inline-flex items-center gap-1 rounded border border-amber-500/60 bg-amber-100/60 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 px-1.5 py-0 text-[10px] font-medium"
                    >
                      <HelpCircle className="w-3 h-3" />
                      Age unknown
                    </span>
                  )}
                </div>
              </div>

              <div>
                <span className="text-xs text-muted-foreground block">Location</span>
                <span className="font-medium">{r.current_ward ?? "—"} {r.current_bed ? `· ${r.current_bed}` : ""}</span>
              </div>
              <div>
                <span className="text-xs text-muted-foreground block">Specialty</span>
                <span className="font-medium">{r.referring_specialty ?? "—"}</span>
              </div>
              <div className="col-span-2">
                <span className="text-xs text-muted-foreground block">Reason</span>
                <span className="font-medium line-clamp-2">{r.reason_for_referral ?? "—"}</span>
              </div>
              <div className="col-span-2">
                <span className="text-xs text-muted-foreground block">Taken by</span>
                <span className="font-medium">
                  {r.created_by && clinicianNames[r.created_by]
                    ? clinicianNames[r.created_by]
                    : "—"}
                </span>
              </div>
              {r.status === "admitted" && (r as any).accepting_consultant && (
                <div className="col-span-2">
                  <span className="text-xs text-muted-foreground block">Accepted by</span>
                  <span className="font-medium">{(r as any).accepting_consultant}</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
