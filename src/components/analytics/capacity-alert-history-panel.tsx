import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Bell, Users } from "lucide-react";
import { getCapacityAlertHistory, type CapacityAlertEvent } from "@/lib/capacity-alerts.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function CapacityAlertHistoryPanel() {
  const fetchHistory = useServerFn(getCapacityAlertHistory);
  const { data, isLoading, error } = useQuery({
    queryKey: ["analytics", "capacity-alert-history"],
    queryFn: () => fetchHistory({ data: { limit: 100 } }),
    staleTime: 30_000,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="h-4 w-4" aria-hidden />
          Capacity alert history
        </CardTitle>
        <CardDescription>
          Push alerts fired when spare admission capacity crossed a per-level threshold.
          Deduped across recipients; most recent 100 events.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : error ? (
          <p className="text-sm text-destructive" role="alert">
            Failed to load alert history: {(error as Error).message}
          </p>
        ) : !data || data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No capacity-crossing alerts have been sent yet.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {data.map((ev: CapacityAlertEvent) => (
              <li key={`${ev.sent_at}|${ev.message}`} className="py-3 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-muted-foreground tabular-nums">
                    {formatWhen(ev.sent_at)}
                  </div>
                  <div className="text-sm mt-0.5 break-words">{ev.message}</div>
                </div>
                <Badge variant="secondary" className="shrink-0 gap-1">
                  <Users className="h-3 w-3" aria-hidden />
                  {ev.recipient_count}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
