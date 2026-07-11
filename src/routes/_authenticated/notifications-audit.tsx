import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { format } from "date-fns";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  getNotificationDeliveryAudit,
  type NotificationDeliveryAuditPage,
  type NotificationDeliveryRow,
} from "@/lib/admin.functions";
import { tzTooltip } from "@/lib/format-timestamp";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type ChannelFilter = "all" | "inapp" | "push";
type StatusFilter = "all" | "generated" | "sent" | "failed" | "gone";

export const Route = createFileRoute("/_authenticated/notifications-audit")({
  head: () => ({
    meta: [
      { title: "Notification delivery audit — SDH Critical Care" },
      { name: "robots", content: "noindex" },
    ],
  }),
  beforeLoad: async () => {
    const { data: userRes } = await supabase.auth.getUser();
    const uid = userRes.user?.id;
    if (!uid) throw redirect({ to: "/auth" });
    const { data: isAdmin } = await supabase.rpc("has_role", {
      _user_id: uid,
      _role: "admin",
    });
    if (!isAdmin) throw redirect({ to: "/" });
  },
  component: NotificationsAuditPage,
});

const PAGE = 50;

function StatusBadge({ status }: { status: NotificationDeliveryRow["status"] }) {
  const cls: Record<string, string> = {
    generated: "bg-muted text-muted-foreground",
    sent: "bg-success/15 text-success border-success/30",
    failed: "bg-destructive/10 text-destructive border-destructive/30",
    gone: "bg-warning/15 text-warning-foreground border-warning/30",
  };
  return (
    <Badge variant="outline" className={cls[status] ?? ""}>
      {status}
    </Badge>
  );
}

function NotificationsAuditPage() {
  const load = useServerFn(getNotificationDeliveryAudit);
  const [rows, setRows] = useState<NotificationDeliveryRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [channel, setChannel] = useState<ChannelFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");

  const fetchPage = async (nextOffset: number, replace: boolean) => {
    setLoading(true);
    try {
      const page: NotificationDeliveryAuditPage = await load({
        data: {
          limit: PAGE,
          offset: nextOffset,
          channel: channel === "all" ? undefined : channel,
          status: status === "all" ? undefined : status,
        },
      });
      setRows((prev) => (replace ? page.rows : [...prev, ...page.rows]));
      setHasMore(page.hasMore);
      setOffset(page.nextOffset);
    } catch (err: any) {
      toast.error(err.message ?? "Failed to load delivery audit.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setRows([]);
    setOffset(0);
    setHasMore(false);
    fetchPage(0, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, status]);

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex items-end justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Notification delivery audit</h1>
          <p className="text-sm text-muted-foreground mt-1">
            When each notification was attempted (<em>generated_at</em>) and delivered
            (<em>delivered_at</em>), the channel it went through, and which actor triggered it.
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <Select value={channel} onValueChange={(v) => setChannel(v as ChannelFilter)}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="Channel" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All channels</SelectItem>
              <SelectItem value="inapp">In-app</SelectItem>
              <SelectItem value="push">Push</SelectItem>
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="generated">Generated</SelectItem>
              <SelectItem value="sent">Sent</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="gone">Gone</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Attempted</TableHead>
              <TableHead>Delivered</TableHead>
              <TableHead>Recipient</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Channel</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Referral</TableHead>
              <TableHead>Error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                  No delivery records match the current filters.
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => {
              const attempted = new Date(r.generated_at);
              const delivered = r.delivered_at ? new Date(r.delivered_at) : null;
              const latencyMs =
                delivered ? delivered.getTime() - attempted.getTime() : null;
              return (
                <TableRow key={r.id}>
                  <TableCell
                    className="whitespace-nowrap text-xs tabular-nums"
                    title={tzTooltip(r.generated_at)}
                  >
                    {format(attempted, "dd MMM HH:mm:ss")}
                  </TableCell>
                  <TableCell
                    className="whitespace-nowrap text-xs tabular-nums"
                    title={delivered ? tzTooltip(r.delivered_at!) : "Not delivered"}
                  >
                    {delivered ? (
                      <span>
                        {format(delivered, "dd MMM HH:mm:ss")}
                        {latencyMs !== null && (
                          <span className="text-muted-foreground ml-1">
                            (+{Math.max(0, Math.round(latencyMs / 100) / 10)}s)
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {r.recipient_name ?? (
                      <span className="text-muted-foreground text-xs">{r.recipient_id.slice(0, 8)}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {r.actor_name ?? (r.actor_id ? (
                      <span className="text-muted-foreground text-xs">{r.actor_id.slice(0, 8)}</span>
                    ) : (
                      <span className="text-muted-foreground text-xs">system</span>
                    ))}
                  </TableCell>
                  <TableCell className="text-xs">{r.kind}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{r.channel}</Badge>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} />
                  </TableCell>
                  <TableCell className="text-xs">
                    {r.referral_id ? (
                      <a
                        className="text-primary hover:underline"
                        href={`/referrals/${r.referral_id}`}
                      >
                        {r.referral_id.slice(0, 8)}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-destructive max-w-xs truncate" title={r.error ?? ""}>
                    {r.error ?? ""}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      <div className="flex justify-center mt-4 gap-2">
        {hasMore && (
          <Button
            variant="outline"
            onClick={() => fetchPage(offset, false)}
            disabled={loading}
          >
            {loading ? "Loading…" : "Load more"}
          </Button>
        )}
        {!hasMore && rows.length > 0 && (
          <span className="text-xs text-muted-foreground py-2">
            End of records ({rows.length} shown)
          </span>
        )}
      </div>
    </div>
  );
}
