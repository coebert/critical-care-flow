import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AdminOnly } from "@/components/admin-only";
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
import { AlertCircle, CheckCircle2, RefreshCcw } from "lucide-react";
import {
  getBridgeStatus,
  runBridgeSyncNow,
  type BridgeResourceStatus,
} from "@/lib/bridge-status.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/bridge-status")({
  head: () => ({
    meta: [{ title: "Bridge sync status — SDH Critical Care" }],
  }),
  errorComponent: ({ error }) => (
    <RouteErrorFallback error={error} label="Bridge status" />
  ),
  component: () => (
    <AdminOnly>
      <BridgeStatusPage />
    </AdminOnly>
  ),
});

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

  const query = useQuery({
    queryKey: ["bridge-status"],
    queryFn: () => getStatus(),
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
    },
    onError: (err: unknown) => {
      toast.error("Sync failed", { description: (err as Error).message });
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
        <div className="flex gap-2">
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
            size="sm"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? "Syncing…" : "Run sync now"}
          </Button>
        </div>
      </div>

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

          <div className="text-xs text-muted-foreground">
            Last checked {fmt(data.ran_at)}.{" "}
            <Link
              to="/notifications-audit"
              className="underline hover:text-foreground"
            >
              View audit log →
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
