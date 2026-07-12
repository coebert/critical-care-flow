import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useRole } from "@/hooks/use-auth";
import { RouteErrorFallback } from "@/components/route-error-fallback";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertCircle, CheckCircle2, RefreshCcw, Beaker } from "lucide-react";
import {
  getBridgeStatus,
  runBridgeSyncNow,
  runBridgeSyncBedsOnly,
  sendBridgeTestPayload,
  getBridgeSyncAttempts,
  getBedBoardVerification,
  getPartnerHealth,
  enqueueBedReconciliation,
  cancelBedReconciliationJob,
  getBedReconciliationJob,
  listBedReconciliationJobs,
  type BridgeResourceStatus,
  type BridgeProbeResult,
  type BridgeSyncAttempt,
  type BedBoardVerificationRow,
  type BedReconcileJob,
  type BedReconcileJobItem,
  type BedReconcileJobDetail,
  type BedReconcileJobSummary,
  type PartnerHealth,
} from "@/lib/bridge-status.functions";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { useState } from "react";
import { tzTooltip } from "@/lib/format-timestamp";



export const Route = createFileRoute("/_authenticated/bridge-status")({
  head: () => ({
    meta: [{ title: "Bridge sync status — SDH Critical Care" }],
  }),
  errorComponent: ({ error }) => (
    <RouteErrorFallback error={error} label="Bridge status" />
  ),
  component: BridgeStatusRoute,
});

function BridgeStatusRoute() {
  const { hasRole, loading } = useRole("admin");
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && !hasRole) {
      toast.error("Admins only", {
        description:
          "The bridge sync status page is restricted to administrators.",
      });
      navigate({ to: "/", replace: true });
    }
  }, [loading, hasRole, navigate]);

  if (loading || !hasRole) {
    return (
      <div className="max-w-5xl mx-auto p-6">
        <Card className="p-6 text-sm text-muted-foreground">
          {loading ? "Checking access…" : "Redirecting…"}
        </Card>
      </div>
    );
  }

  return <BridgeStatusPage />;
}


function fmt(ts: string | null) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function relative(ts: string | null, nowMs: number = Date.now()) {
  if (!ts) return "never";
  const diffMs = nowMs - new Date(ts).getTime();
  const sec = Math.max(1, Math.floor(diffMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 1) return "<1s";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

/**
 * Ticks every second so relative timestamps and live durations refresh
 * in the UI while a job is in-flight. Gated by `active` so we don't burn
 * a timer on idle panels.
 */
function useNowTick(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

function BridgeStatusPage() {

  const getStatus = useServerFn(getBridgeStatus);
  const runNow = useServerFn(runBridgeSyncNow);
  const runBedsOnly = useServerFn(runBridgeSyncBedsOnly);
  const sendProbe = useServerFn(sendBridgeTestPayload);
  const getAttempts = useServerFn(getBridgeSyncAttempts);
  const getVerification = useServerFn(getBedBoardVerification);
  const getHealth = useServerFn(getPartnerHealth);

  const [probeResults, setProbeResults] = useState<BridgeProbeResult[] | null>(
    null,
  );

  const query = useQuery({
    queryKey: ["bridge-status"],
    queryFn: () => getStatus(),
    refetchInterval: 15_000,
  });

  const attemptsQuery = useQuery({
    queryKey: ["bridge-sync-attempts"],
    queryFn: () => getAttempts(),
    refetchInterval: 15_000,
  });

  const verifyQuery = useQuery({
    queryKey: ["bed-board-verification"],
    queryFn: () => getVerification(),
    refetchInterval: 15_000,
  });

  const mutation = useMutation({
    mutationFn: () => runNow(),
    onSuccess: (res) => {
      const ok = res.status < 300;
      const message = `Sync ${ok ? "completed" : "finished with errors"} (HTTP ${res.status})`;
      if (ok) toast.success(message);
      else toast.warning(message);
      query.refetch();
      attemptsQuery.refetch();
      verifyQuery.refetch();
    },
    onError: (err: unknown) => {
      toast.error("Sync failed", { description: (err as Error).message });
    },
  });

  const bedsMutation = useMutation({
    mutationFn: () => runBedsOnly(),
    onSuccess: (res) => {
      const ok = res.status < 300;
      const message = `Beds sync ${ok ? "completed" : "finished with errors"} (HTTP ${res.status})`;
      if (ok) toast.success(message);
      else toast.warning(message);
      query.refetch();
      attemptsQuery.refetch();
      verifyQuery.refetch();
    },
    onError: (err: unknown) => {
      toast.error("Beds sync failed", {
        description: (err as Error).message,
      });
    },
  });

  const probeMutation = useMutation({
    mutationFn: () => sendProbe(),
    onSuccess: (res) => {
      setProbeResults(res.results);
      const passed = res.results.filter((r) => r.ok).length;
      const total = res.results.length;
      const message = `Contract probe: ${passed}/${total} endpoints healthy`;
      if (res.ok) toast.success(message);
      else toast.warning(message);
    },
    onError: (err: unknown) => {
      toast.error("Test payload failed", {
        description: (err as Error).message,
      });
    },
  });

  const data = query.data;

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Bridge sync status</h1>
          <p className="text-sm text-muted-foreground">
            ICU Handover Hub ⇄ Critical Care Connect. Auto-refreshes every 15s.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCcw
              className={`h-4 w-4 mr-1 ${query.isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => probeMutation.mutate()}
            disabled={probeMutation.isPending}
            title="Probes every partner endpoint with an intentionally empty record. Nothing is written."
          >
            <Beaker
              className={`h-4 w-4 mr-1 ${probeMutation.isPending ? "animate-pulse" : ""}`}
            />
            {probeMutation.isPending ? "Probing…" : "Send test payload"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => bedsMutation.mutate()}
            disabled={bedsMutation.isPending}
            title="Runs the sync worker restricted to beds, bed_occupancies, bed_outliers, and bed_transfers_out."
          >
            {bedsMutation.isPending ? "Syncing beds…" : "Sync beds only"}
          </Button>
          <Button
            size="sm"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? "Syncing…" : "Run sync now"}
          </Button>
        </div>
      </div>

      {probeResults && (
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Partner contract probe</div>
              <p className="text-xs text-muted-foreground">
                Empty payloads sent to each partner endpoint. A 400 response
                means the contract is intact — no rows were created.
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setProbeResults(null)}
            >
              Dismiss
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {probeResults.map((p) => (
              <div
                key={p.resource}
                className="flex items-start gap-2 rounded-md border p-2"
              >
                {p.ok ? (
                  <CheckCircle2 className="h-4 w-4 mt-0.5 text-emerald-600 shrink-0" />
                ) : (
                  <AlertCircle className="h-4 w-4 mt-0.5 text-amber-600 shrink-0" />
                )}
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{p.resource}</span>
                    <Badge variant={p.ok ? "secondary" : "destructive"}>
                      HTTP {p.status || "—"}
                    </Badge>
                  </div>
                  <div
                    className="text-xs text-muted-foreground truncate"
                    title={p.message}
                  >
                    {p.message}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}


      {query.isError && (
        <Card className="p-4 border-destructive">
          <div className="flex items-center gap-2 text-destructive">
            <AlertCircle className="h-4 w-4" />
            {(query.error as Error).message}
          </div>
        </Card>
      )}

      {data && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryStat
              label="Overall"
              value={data.ok ? "Healthy" : "Errors"}
              ok={data.ok}
            />
            <SummaryStat
              label="Shared secret"
              value={data.secret_configured ? "Configured" : "Missing"}
              ok={data.secret_configured}
            />
            <SummaryStat
              label="Partner URL"
              value={data.partner_configured ? "Configured" : "Missing"}
              ok={data.partner_configured}
            />
            <SummaryStat
              label="Cron"
              value={
                data.cron_active
                  ? data.cron_schedule ?? "Active"
                  : "Not scheduled"
              }
              ok={data.cron_active}
            />
          </div>

          <Card className="p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Resource</TableHead>
                  <TableHead className="text-right">Local rows</TableHead>
                  <TableHead>Last pulled (partner→us)</TableHead>
                  <TableHead>Last pushed (us→partner)</TableHead>
                  <TableHead>Latest local change</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.resources.map((r) => (
                  <ResourceRow key={r.resource} r={r} />
                ))}
              </TableBody>
            </Table>
          </Card>

          <BedBoardVerificationPanel
            rows={verifyQuery.data?.rows ?? []}
            ranAt={verifyQuery.data?.ran_at ?? null}
            loading={verifyQuery.isLoading}
            error={verifyQuery.error as Error | null}
            onRefresh={() => verifyQuery.refetch()}
            refreshing={verifyQuery.isFetching}
          />

          <ReconcilePanel
            stale={(verifyQuery.data?.rows ?? []).some((r) => r.stale)}
            onDone={() => {
              verifyQuery.refetch();
              query.refetch();
              attemptsQuery.refetch();
            }}
          />



          <AttemptsPanel
            attempts={attemptsQuery.data ?? []}
            loading={attemptsQuery.isLoading}
          />

          <div className="text-xs text-muted-foreground">
            Last checked {fmt(data.ran_at)}. Failed resources are automatically
            retried every 5 minutes.{" "}
            <Link
              to="/notifications-audit"
              className="underline hover:text-foreground"
            >
              View notifications audit log →
            </Link>
          </div>
        </>
      )}

      {query.isLoading && (
        <Card className="p-6 text-sm text-muted-foreground">
          Loading bridge status…
        </Card>
      )}
    </div>
  );
}

function SummaryStat({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok: boolean;
}) {
  return (
    <Card className="p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 flex items-center gap-2">
        {ok ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        ) : (
          <AlertCircle className="h-4 w-4 text-amber-600" />
        )}
        <span className="font-medium">{value}</span>
      </div>
    </Card>
  );
}

function ResourceRow({ r }: { r: BridgeResourceStatus }) {
  const hasError = Boolean(r.last_error);
  return (
    <TableRow>
      <TableCell className="font-medium">{r.resource}</TableCell>
      <TableCell className="text-right tabular-nums">
        {r.row_count.toLocaleString()}
      </TableCell>
      <TableCell>
        <div>{fmt(r.last_pulled_at)}</div>
        <div className="text-xs text-muted-foreground">
          {relative(r.last_pulled_at)}
        </div>
      </TableCell>
      <TableCell>
        <div>{fmt(r.last_pushed_at)}</div>
        <div className="text-xs text-muted-foreground">
          {relative(r.last_pushed_at)}
        </div>
      </TableCell>
      <TableCell>
        <div>{fmt(r.latest_updated_at)}</div>
        <div className="text-xs text-muted-foreground">
          {relative(r.latest_updated_at)}
        </div>
      </TableCell>
      <TableCell>
        {hasError ? (
          <div className="space-y-1">
            <Badge variant="destructive">Error</Badge>
            <div
              className="text-xs text-muted-foreground max-w-[24ch] truncate"
              title={r.last_error ?? ""}
            >
              {r.last_error}
            </div>
            <div className="text-xs text-muted-foreground">
              {relative(r.last_error_at)}
            </div>
          </div>
        ) : (
          <Badge variant="secondary">OK</Badge>
        )}
      </TableCell>
    </TableRow>
  );
}

function sourceLabel(source: BridgeSyncAttempt["source"]) {
  switch (source) {
    case "sync":
      return "Scheduled";
    case "retry":
      return "Auto-retry";
    case "manual":
      return "Manual";
    default:
      return source;
  }
}

function AttemptsPanel({
  attempts,
  loading,
}: {
  attempts: BridgeSyncAttempt[];
  loading: boolean;
}) {
  return (
    <Card className="p-0 overflow-hidden">
      <div className="px-4 py-3 border-b flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">Sync attempts audit log</div>
          <p className="text-xs text-muted-foreground">
            Every scheduled sync, auto-retry, and manual run, most recent first.
          </p>
        </div>
        <Badge variant="secondary">{attempts.length} shown</Badge>
      </div>
      {loading ? (
        <div className="p-4 text-sm text-muted-foreground">
          Loading audit log…
        </div>
      ) : attempts.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">
          No sync attempts recorded yet.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Resource</TableHead>
              <TableHead>Result</TableHead>
              <TableHead className="text-right">Pulled</TableHead>
              <TableHead className="text-right">Pushed</TableHead>
              <TableHead className="text-right">Duration</TableHead>
              <TableHead>Error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {attempts.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="whitespace-nowrap">
                  <div>{fmt(a.attempted_at)}</div>
                  <div className="text-xs text-muted-foreground">
                    {relative(a.attempted_at)}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{sourceLabel(a.source)}</Badge>
                </TableCell>
                <TableCell className="font-medium">{a.resource}</TableCell>
                <TableCell>
                  {a.ok ? (
                    <Badge variant="secondary">OK</Badge>
                  ) : (
                    <Badge variant="destructive">Failed</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {a.pulled}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {a.pushed}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {a.duration_ms != null ? `${a.duration_ms}ms` : "—"}
                </TableCell>
                <TableCell
                  className="max-w-[32ch] truncate text-xs text-muted-foreground"
                  title={a.error ?? ""}
                >
                  {a.error ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

function BedBoardVerificationPanel({
  rows,
  ranAt,
  loading,
  error,
  onRefresh,
  refreshing,
}: {
  rows: BedBoardVerificationRow[];
  ranAt: string | null;
  loading: boolean;
  error: Error | null;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const staleCount = rows.filter((r) => r.stale).length;
  return (
    <Card className="p-0 overflow-hidden">
      <div className="px-4 py-3 border-b flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="text-sm font-medium">Bed board verification</div>
          <p className="text-xs text-muted-foreground">
            Cross-checks each synced bed table against what the bed board query
            returns. Flags lag and missing/extra records.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {rows.length > 0 &&
            (staleCount === 0 ? (
              <Badge variant="secondary">All in sync</Badge>
            ) : (
              <Badge variant="destructive">
                {staleCount} stale
              </Badge>
            ))}
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing}
          >
            <RefreshCcw
              className={`h-4 w-4 mr-1 ${refreshing ? "animate-spin" : ""}`}
            />
            Recheck
          </Button>
        </div>
      </div>
      {error ? (
        <div className="p-4 text-sm text-destructive flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          {error.message}
        </div>
      ) : loading ? (
        <div className="p-4 text-sm text-muted-foreground">
          Running verification…
        </div>
      ) : rows.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">
          No verification data yet.
        </div>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Table</TableHead>
                <TableHead className="text-right">Synced</TableHead>
                <TableHead className="text-right">On board</TableHead>
                <TableHead className="text-right">Δ</TableHead>
                <TableHead>Latest synced row</TableHead>
                <TableHead>Last pulled</TableHead>
                <TableHead className="text-right">Lag</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const delta = r.synced_rows - r.board_rows;
                return (
                  <TableRow key={r.table}>
                    <TableCell className="font-medium">{r.table}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.synced_rows.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.board_rows.toLocaleString()}
                    </TableCell>
                    <TableCell
                      className={`text-right tabular-nums ${delta !== 0 ? "text-amber-600 font-medium" : "text-muted-foreground"}`}
                    >
                      {delta > 0 ? `+${delta}` : delta}
                    </TableCell>
                    <TableCell>
                      <div>{fmt(r.latest_synced_at)}</div>
                      <div className="text-xs text-muted-foreground">
                        {relative(r.latest_synced_at)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div>{fmt(r.last_pulled_at)}</div>
                      <div className="text-xs text-muted-foreground">
                        {relative(r.last_pulled_at)}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.lag_seconds == null
                        ? "—"
                        : r.lag_seconds < 60
                          ? `${r.lag_seconds}s`
                          : `${Math.round(r.lag_seconds / 60)}m`}
                    </TableCell>
                    <TableCell>
                      {r.stale ? (
                        <Badge variant="destructive">Stale</Badge>
                      ) : (
                        <Badge variant="secondary">OK</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {rows.some(
            (r) => r.missing_from_board.length || r.extra_on_board.length,
          ) && (
            <div className="border-t p-4 space-y-3 bg-muted/30">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Record discrepancies
              </div>
              {rows.map((r) =>
                r.missing_from_board.length || r.extra_on_board.length ? (
                  <div key={r.table} className="text-xs space-y-1">
                    <div className="font-medium">{r.table}</div>
                    {r.missing_from_board.length > 0 && (
                      <div className="text-amber-700">
                        Missing from board ({r.missing_from_board.length}
                        {r.missing_from_board.length >= 10 ? "+" : ""}):{" "}
                        <code className="text-[11px] break-all">
                          {r.missing_from_board.join(", ")}
                        </code>
                      </div>
                    )}
                    {r.extra_on_board.length > 0 && (
                      <div className="text-amber-700">
                        Extra on board ({r.extra_on_board.length}
                        {r.extra_on_board.length >= 10 ? "+" : ""}):{" "}
                        <code className="text-[11px] break-all">
                          {r.extra_on_board.join(", ")}
                        </code>
                      </div>
                    )}
                  </div>
                ) : null,
              )}
            </div>
          )}
          {ranAt && (
            <div className="border-t px-4 py-2 text-xs text-muted-foreground">
              Verified {relative(ranAt)}.
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function toLocalInputValue(d: Date): string {
  // <input type="datetime-local"> expects "YYYY-MM-DDTHH:mm" in local time.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

const ITEM_STATUS_STYLES: Record<
  BedReconcileJobItem["status"],
  { label: string; variant: "default" | "secondary" | "outline" | "destructive" }
> = {
  pending: { label: "Pending", variant: "outline" },
  running: { label: "Running", variant: "default" },
  complete: { label: "Complete", variant: "secondary" },
  error: { label: "Error", variant: "destructive" },
  locked: { label: "Locked", variant: "destructive" },
  skipped: { label: "Skipped", variant: "outline" },
};

const JOB_STATUS_STYLES: Record<
  BedReconcileJob["status"],
  { label: string; variant: "default" | "secondary" | "outline" | "destructive" }
> = {
  queued: { label: "Queued", variant: "outline" },
  running: { label: "Running", variant: "default" },
  complete: { label: "Complete", variant: "secondary" },
  failed: { label: "Failed", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "outline" },
};

function isTerminalJobStatus(status: BedReconcileJob["status"]): boolean {
  return (
    status === "complete" || status === "failed" || status === "cancelled"
  );
}

function ReconcilePanel({
  stale,
  onDone,
}: {
  stale: boolean;
  onDone: () => void;
}) {
  const enqueueFn = useServerFn(enqueueBedReconciliation);
  const getJobFn = useServerFn(getBedReconciliationJob);
  const listJobsFn = useServerFn(listBedReconciliationJobs);
  const cancelFn = useServerFn(cancelBedReconciliationJob);

  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [from, setFrom] = useState(toLocalInputValue(defaultFrom));
  const [to, setTo] = useState(toLocalInputValue(now));
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [pendingDryRun, setPendingDryRun] = useState(false);

  const jobDetailQuery = useQuery({
    queryKey: ["bed-reconcile-job", activeJobId],
    queryFn: () => getJobFn({ data: { jobId: activeJobId! } }),
    enabled: !!activeJobId,
  });

  const historyQuery = useQuery({
    queryKey: ["bed-reconcile-jobs"],
    queryFn: () => listJobsFn({ data: { limit: 5 } }),
    refetchInterval: 15000,
  });

  // Realtime: patch the active job + its items as the worker updates them.
  useEffect(() => {
    if (!activeJobId) return;
    const channel = supabase
      .channel(`bridge-reconcile-${activeJobId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "bridge_reconcile_jobs",
          filter: `id=eq.${activeJobId}`,
        },
        () => {
          jobDetailQuery.refetch();
          historyQuery.refetch();
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "bridge_reconcile_job_items",
          filter: `job_id=eq.${activeJobId}`,
        },
        () => {
          jobDetailQuery.refetch();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobId]);

  const detail = jobDetailQuery.data as BedReconcileJobDetail | null | undefined;
  const jobStatus = detail?.job.status;
  const terminal = jobStatus ? isTerminalJobStatus(jobStatus) : false;

  // When the active job reaches a terminal state, refresh sibling panels once.
  const [notifiedTerminalFor, setNotifiedTerminalFor] = useState<string | null>(
    null,
  );
  useEffect(() => {
    if (!detail || !terminal) return;
    if (notifiedTerminalFor === detail.job.id) return;
    setNotifiedTerminalFor(detail.job.id);
    if (!detail.job.dry_run) onDone();
    if (detail.job.status === "complete") {
      toast.success(
        detail.job.dry_run ? "Dry-run complete" : "Reconciliation complete",
      );
    } else if (detail.job.status === "failed") {
      toast.error("Reconciliation failed", {
        description: detail.job.error ?? undefined,
      });
    } else if (detail.job.status === "cancelled") {
      toast.warning("Reconciliation cancelled");
    }
  }, [detail, terminal, notifiedTerminalFor, onDone]);

  const enqueueMutation = useMutation({
    mutationFn: (input: { from: string; to: string; dryRun: boolean }) =>
      enqueueFn({ data: input }),
    onSuccess: (res: { jobId: string }, vars) => {
      setPendingDryRun(vars.dryRun);
      setNotifiedTerminalFor(null);
      setActiveJobId(res.jobId);
      historyQuery.refetch();
      toast.info(
        vars.dryRun ? "Dry-run queued" : "Reconciliation queued",
        {
          description:
            "Progress will appear below as the worker picks up the job.",
        },
      );
    },
    onError: (err: unknown) => {
      toast.error("Could not queue reconciliation", {
        description: (err as Error).message,
      });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelFn({ data: { jobId: activeJobId! } }),
    onSuccess: (res: { cancelled: boolean }) => {
      if (res.cancelled) toast.info("Cancellation requested");
      else toast.warning("Job already finished");
      jobDetailQuery.refetch();
      historyQuery.refetch();
    },
  });

  const runWindow = (hours: number, dryRun: boolean) => {
    const end = new Date();
    const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
    setFrom(toLocalInputValue(start));
    setTo(toLocalInputValue(end));
    enqueueMutation.mutate({
      from: start.toISOString(),
      to: end.toISOString(),
      dryRun,
    });
  };

  const runCustom = (dryRun: boolean) => {
    const startISO = new Date(from).toISOString();
    const endISO = new Date(to).toISOString();
    enqueueMutation.mutate({ from: startISO, to: endISO, dryRun });
  };

  const totalItems = detail?.items.length ?? 0;
  const doneItems =
    detail?.items.filter((i) =>
      ["complete", "error", "locked", "skipped"].includes(i.status),
    ).length ?? 0;
  const overallPercent =
    totalItems > 0 ? Math.round((doneItems / totalItems) * 100) : 0;

  return (
    <Card className="p-0 overflow-hidden">
      <div className="px-4 py-3 border-b flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="text-sm font-medium flex items-center gap-2">
            Reconcile / backfill bed rows
            {stale && (
              <Badge variant="destructive" className="text-[10px]">
                Board stale
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Backfills run in the background. Progress streams in live per
            table, so the UI stays responsive even for wide windows. Sync
            cursors are left untouched.
          </p>
        </div>
      </div>

      <div className="p-4 space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => runWindow(1, true)}
            disabled={enqueueMutation.isPending}
          >
            Dry-run 1h
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => runWindow(24, true)}
            disabled={enqueueMutation.isPending}
          >
            Dry-run 24h
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => runWindow(24 * 7, true)}
            disabled={enqueueMutation.isPending}
          >
            Dry-run 7d
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto] items-end">
          <div className="space-y-1">
            <Label htmlFor="reconcile-from" className="text-xs">
              From
            </Label>
            <Input
              id="reconcile-from"
              type="datetime-local"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="reconcile-to" className="text-xs">
              To
            </Label>
            <Input
              id="reconcile-to"
              type="datetime-local"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => runCustom(true)}
            disabled={enqueueMutation.isPending || !from || !to}
          >
            {enqueueMutation.isPending && pendingDryRun
              ? "Queueing…"
              : "Dry-run"}
          </Button>
          <Button
            size="sm"
            onClick={() => runCustom(false)}
            disabled={enqueueMutation.isPending || !from || !to}
          >
            {enqueueMutation.isPending && !pendingDryRun
              ? "Queueing…"
              : "Run reconcile"}
          </Button>
        </div>

        {detail && (
          <ActiveJobCard
            detail={detail}
            overallPercent={overallPercent}
            onCancel={() => cancelMutation.mutate()}
            cancelling={cancelMutation.isPending}
          />
        )}

        {(historyQuery.data?.length ?? 0) > 0 && (
          <JobHistoryTable
            jobs={historyQuery.data ?? []}
            activeJobId={activeJobId}
            onSelect={(id) => {
              setNotifiedTerminalFor(id); // don't retoast old jobs
              setActiveJobId(id);
            }}
          />
        )}
      </div>
    </Card>
  );
}

function ActiveJobCard({
  detail,
  overallPercent,
  onCancel,
  cancelling,
}: {
  detail: BedReconcileJobDetail;
  overallPercent: number;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const { job, items } = detail;
  const statusStyle = JOB_STATUS_STYLES[job.status];
  const canCancel = job.status === "queued" || job.status === "running";

  // Live-tick every second while the job (or any item) is in flight, so
  // "started 12s ago" and running durations advance without a refetch.
  const anyRunning =
    !isTerminalJobStatus(job.status) ||
    items.some((i) => i.status === "running");
  const nowMs = useNowTick(anyRunning);

  // Job-level timeline points, in the order the worker moves through them.
  const timeline: { label: string; ts: string | null }[] = [
    { label: "Queued", ts: job.created_at },
    { label: "Started", ts: job.started_at },
    { label: "Finished", ts: job.finished_at },
  ];

  // Elapsed since job started (for the header duration chip).
  const jobElapsed =
    job.started_at != null
      ? (job.finished_at ? new Date(job.finished_at).getTime() : nowMs) -
        new Date(job.started_at).getTime()
      : null;

  return (
    <div className="border-t pt-3 space-y-3">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="space-y-1">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            Active job
            <Badge variant={statusStyle.variant} className="text-[10px]">
              {statusStyle.label}
            </Badge>
            {job.dry_run && (
              <Badge variant="outline" className="text-[10px]">
                dry-run
              </Badge>
            )}
            {jobElapsed != null && (
              <Badge variant="outline" className="text-[10px] tabular-nums">
                {formatDuration(jobElapsed)}
              </Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            Window {fmt(job.from_ts)} → {fmt(job.to_ts)}
          </div>
        </div>
        {canCancel && (
          <Button
            size="sm"
            variant="outline"
            onClick={onCancel}
            disabled={cancelling}
          >
            {cancelling ? "Cancelling…" : "Cancel job"}
          </Button>
        )}
      </div>

      {/* Job timeline strip — makes the queued→running→finished transition
          and its exact timestamps first-class visible. */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {timeline.map((p) => (
          <div key={p.label} className="flex items-center gap-1.5">
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full ${
                p.ts ? "bg-primary" : "bg-muted-foreground/30"
              }`}
            />
            <span className="font-medium text-foreground/80">{p.label}</span>
            {p.ts ? (
              <span title={tzTooltip(p.ts)} className="tabular-nums">
                {fmt(p.ts)} · {relative(p.ts, nowMs)}
              </span>
            ) : (
              <span>—</span>
            )}
          </div>
        ))}
      </div>

      <div className="space-y-1">
        <div className="flex justify-between text-[11px] text-muted-foreground">
          <span>Overall progress</span>
          <span>{overallPercent}%</span>
        </div>
        <Progress value={overallPercent} />
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Table</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">
              {job.dry_run ? "Would pull" : "Pulled"}
            </TableHead>
            <TableHead className="text-right">
              {job.dry_run ? "Would push" : "Pushed"}
            </TableHead>
            <TableHead className="text-right">Skipped</TableHead>
            <TableHead>Started</TableHead>
            <TableHead className="text-right">Duration</TableHead>
            <TableHead>Last update</TableHead>
            <TableHead>Detail</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((it) => {
            const style = ITEM_STATUS_STYLES[it.status];
            const startedMs = it.started_at
              ? new Date(it.started_at).getTime()
              : null;
            const endedMs =
              it.finished_at != null
                ? new Date(it.finished_at).getTime()
                : it.status === "running" && startedMs != null
                  ? nowMs
                  : null;
            const duration =
              startedMs != null && endedMs != null ? endedMs - startedMs : null;
            return (
              <TableRow key={it.id}>
                <TableCell className="font-medium align-top">
                  {it.resource}
                </TableCell>
                <TableCell className="align-top">
                  <div className="flex items-center gap-2">
                    <Badge variant={style.variant} className="text-[10px]">
                      {style.label}
                    </Badge>
                    {it.status === "running" && (
                      <RefreshCcw className="w-3 h-3 animate-spin text-muted-foreground" />
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums align-top">
                  {it.pulled}
                </TableCell>
                <TableCell className="text-right tabular-nums align-top">
                  {it.pushed}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground align-top">
                  {it.skipped}
                </TableCell>
                <TableCell className="align-top">
                  {it.started_at ? (
                    <span
                      className="text-[11px] text-muted-foreground tabular-nums"
                      title={tzTooltip(it.started_at)}
                    >
                      {fmt(it.started_at)}
                      <br />
                      <span className="text-foreground/60">
                        {relative(it.started_at, nowMs)}
                      </span>
                    </span>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums align-top text-[11px]">
                  {duration != null ? formatDuration(duration) : "—"}
                </TableCell>
                <TableCell className="align-top">
                  <span
                    className="text-[11px] text-muted-foreground tabular-nums"
                    title={tzTooltip(it.updated_at)}
                  >
                    {relative(it.updated_at, nowMs)}
                  </span>
                </TableCell>
                <TableCell className="align-top">
                  {it.status === "locked" && (
                    <span
                      className="text-[11px] text-muted-foreground"
                      title={
                        it.locked_since ? tzTooltip(it.locked_since) : undefined
                      }
                    >
                      Held since{" "}
                      {it.locked_since ? relative(it.locked_since, nowMs) : "—"}
                    </span>
                  )}
                  {it.status === "error" && it.error && (
                    <span
                      className="text-xs text-destructive block max-w-[32ch] truncate"
                      title={it.error}
                    >
                      {it.error}
                    </span>
                  )}
                  {it.status === "complete" && it.finished_at && (
                    <span
                      className="text-[11px] text-muted-foreground"
                      title={tzTooltip(it.finished_at)}
                    >
                      Done {relative(it.finished_at, nowMs)}
                    </span>
                  )}
                  {it.status === "skipped" && (
                    <span className="text-[11px] text-muted-foreground">
                      Skipped this run
                    </span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {job.error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {job.error}
        </div>
      )}
    </div>
  );
}

function JobHistoryTable({
  jobs,
  activeJobId,
  onSelect,
}: {
  jobs: BedReconcileJobSummary[];
  activeJobId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="border-t pt-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
        Recent jobs
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Window</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Pulled</TableHead>
            <TableHead className="text-right">Pushed</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((j) => {
            const style = JOB_STATUS_STYLES[j.status];
            const isActive = j.id === activeJobId;
            return (
              <TableRow key={j.id}>
                <TableCell className="text-xs whitespace-nowrap">
                  {relative(j.created_at)}
                </TableCell>
                <TableCell className="text-xs whitespace-nowrap">
                  {fmt(j.from_ts)} → {fmt(j.to_ts)}
                  {j.dry_run && (
                    <Badge variant="outline" className="ml-2 text-[10px]">
                      dry-run
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={style.variant} className="text-[10px]">
                    {style.label}
                  </Badge>
                  {j.totals.errored > 0 && (
                    <Badge
                      variant="destructive"
                      className="ml-1 text-[10px]"
                    >
                      {j.totals.errored} err
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums text-xs">
                  {j.totals.pulled}
                </TableCell>
                <TableCell className="text-right tabular-nums text-xs">
                  {j.totals.pushed}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant={isActive ? "secondary" : "ghost"}
                    onClick={() => onSelect(j.id)}
                    disabled={isActive}
                  >
                    {isActive ? "Viewing" : "View"}
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}


