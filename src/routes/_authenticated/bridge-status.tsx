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
  sendBridgeTestPayload,
  getBridgeSyncAttempts,
  getBedBoardVerification,
  runBedReconciliation,
  type BridgeResourceStatus,
  type BridgeProbeResult,
  type BridgeSyncAttempt,
  type BedBoardVerificationRow,
  type BedReconcileResourceResult,
} from "@/lib/bridge-status.functions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { useState } from "react";


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

function relative(ts: string | null) {
  if (!ts) return "never";
  const diffMs = Date.now() - new Date(ts).getTime();
  const sec = Math.max(1, Math.floor(diffMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function BridgeStatusPage() {

  const getStatus = useServerFn(getBridgeStatus);
  const runNow = useServerFn(runBridgeSyncNow);
  const sendProbe = useServerFn(sendBridgeTestPayload);
  const getAttempts = useServerFn(getBridgeSyncAttempts);
  const getVerification = useServerFn(getBedBoardVerification);

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

function ReconcilePanel({
  stale,
  onDone,
}: {
  stale: boolean;
  onDone: () => void;
}) {
  const reconcileFn = useServerFn(runBedReconciliation);
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [from, setFrom] = useState(toLocalInputValue(defaultFrom));
  const [to, setTo] = useState(toLocalInputValue(now));
  const [lastResults, setLastResults] = useState<
    BedReconcileResourceResult[] | null
  >(null);

  const mutation = useMutation({
    mutationFn: (input: { from: string; to: string }) =>
      reconcileFn({ data: input }),
    onSuccess: (res) => {
      setLastResults(res.results);
      const pulled = res.results.reduce((n, r) => n + r.pulled, 0);
      const pushed = res.results.reduce((n, r) => n + r.pushed, 0);
      const errors = res.results.filter((r) => r.error).length;
      const msg = `Reconciled ${pulled} pulled / ${pushed} pushed across ${res.results.length} bed tables`;
      if (errors === 0) toast.success(msg);
      else toast.warning(`${msg} (${errors} with errors)`);
      onDone();
    },
    onError: (err: unknown) => {
      toast.error("Reconciliation failed", {
        description: (err as Error).message,
      });
    },
  });

  const runWindow = (hours: number) => {
    const end = new Date();
    const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
    setFrom(toLocalInputValue(start));
    setTo(toLocalInputValue(end));
    mutation.mutate({
      from: start.toISOString(),
      to: end.toISOString(),
    });
  };

  const runCustom = () => {
    // Convert the datetime-local strings (in the admin's local zone) into
    // ISO UTC so the server-side range matches how updated_at is stored.
    const startISO = new Date(from).toISOString();
    const endISO = new Date(to).toISOString();
    mutation.mutate({ from: startISO, to: endISO });
  };

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
            Re-pulls partner rows and re-pushes local bed rows updated inside
            the chosen window. Sync cursors are left untouched.
          </p>
        </div>
      </div>

      <div className="p-4 space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => runWindow(1)}
            disabled={mutation.isPending}
          >
            Last 1h
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => runWindow(24)}
            disabled={mutation.isPending}
          >
            Last 24h
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => runWindow(24 * 7)}
            disabled={mutation.isPending}
          >
            Last 7d
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] items-end">
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
            onClick={runCustom}
            disabled={mutation.isPending || !from || !to}
          >
            {mutation.isPending ? "Reconciling…" : "Run reconcile"}
          </Button>
        </div>

        {lastResults && (
          <div className="border-t pt-3">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
              Last reconciliation
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Table</TableHead>
                  <TableHead className="text-right">Pulled</TableHead>
                  <TableHead className="text-right">Pushed</TableHead>
                  <TableHead className="text-right">Skipped</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lastResults.map((r) => (
                  <TableRow key={r.resource}>
                    <TableCell className="font-medium">{r.resource}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.pulled}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.pushed}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {r.skipped}
                    </TableCell>
                    <TableCell>
                      {r.error ? (
                        <span
                          className="text-xs text-destructive truncate block max-w-[32ch]"
                          title={r.error}
                        >
                          {r.error}
                        </span>
                      ) : (
                        <Badge variant="secondary">OK</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </Card>
  );
}
