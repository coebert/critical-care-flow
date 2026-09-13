import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { format } from "date-fns";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  getNotificationLifecycleAudit,
  type NotificationLifecycleAuditPage,
  type NotificationLifecycleRow,
} from "@/lib/admin.functions";
import { tzTooltip } from "@/lib/format-timestamp";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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

type StateFilter = "all" | "unread" | "read" | "unused" | "used" | "expired";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/_authenticated/notifications-lifecycle")({
  head: () => ({
    meta: [
      { title: "Notification lifecycle audit — SDH Critical Care" },
      { name: "robots", content: "noindex" },
    ],
  }),
  beforeLoad: async () => {
    const { data: userRes } = await supabase.auth.getUser();
    const uid = userRes.user?.id;
    if (!uid) throw redirect({ to: "/auth", search: {} });
    const { data: isAdmin } = await supabase.rpc("has_role", {
      _user_id: uid,
      _role: "admin",
    });
    if (!isAdmin) throw redirect({ to: "/" });
  },
  component: NotificationsLifecyclePage,
});

const PAGE = 50;

function StatusPill({ label, tone }: { label: string; tone: "muted" | "ok" | "warn" | "bad" }) {
  const cls: Record<string, string> = {
    muted: "bg-muted text-muted-foreground",
    ok: "bg-success/15 text-success border-success/30",
    warn: "bg-warning/15 text-warning-foreground border-warning/30",
    bad: "bg-destructive/10 text-destructive border-destructive/30",
  };
  return (
    <Badge variant="outline" className={cls[tone]}>
      {label}
    </Badge>
  );
}

function NotificationsLifecyclePage() {
  const load = useServerFn(getNotificationLifecycleAudit);
  const [rows, setRows] = useState<NotificationLifecycleRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [state, setState] = useState<StateFilter>("all");
  const [userFilter, setUserFilter] = useState("");
  const [referralFilter, setReferralFilter] = useState("");

  const fetchPage = async (nextOffset: number, replace: boolean) => {
    setLoading(true);
    try {
      const page: NotificationLifecycleAuditPage = await load({
        data: {
          limit: PAGE,
          offset: nextOffset,
          state: state === "all" ? undefined : state,
          user_id: UUID_RE.test(userFilter) ? userFilter : undefined,
          referral_id: UUID_RE.test(referralFilter) ? referralFilter : undefined,
        },
      });
      setRows((prev) => (replace ? page.rows : [...prev, ...page.rows]));
      setHasMore(page.hasMore);
      setOffset(page.nextOffset);
    } catch (err: any) {
      toast.error(err.message ?? "Failed to load lifecycle audit.");
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
  }, [state, userFilter, referralFilter]);

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="flex items-end justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Notification lifecycle audit</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            For each notification: when it was created, the referral it was
            attached to, when it was consumed by a deep-link click (from the
            audit log, single-use per user), and when it was marked read.
            Mismatches — a notification id used against a referral other than
            its own — are highlighted for investigation.{" "}
            <Link to="/notifications-audit" className="underline hover:text-foreground">
              Delivery audit →
            </Link>
          </p>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          <Input
            className="w-64"
            placeholder="Recipient user id (UUID)"
            value={userFilter}
            onChange={(e) => setUserFilter(e.target.value.trim())}
          />
          <Input
            className="w-64"
            placeholder="Referral id (UUID)"
            value={referralFilter}
            onChange={(e) => setReferralFilter(e.target.value.trim())}
          />
          <Select value={state} onValueChange={(v) => setState(v as StateFilter)}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="State" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All states</SelectItem>
              <SelectItem value="unread">Unread</SelectItem>
              <SelectItem value="read">Read</SelectItem>
              <SelectItem value="unused">Unused</SelectItem>
              <SelectItem value="used">Used</SelectItem>
              <SelectItem value="expired">Expired</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Notification</TableHead>
              <TableHead>Recipient</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Referral</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Used (deep-link)</TableHead>
              <TableHead>Read</TableHead>
              <TableHead>Expired (unused)</TableHead>
              <TableHead>State</TableHead>

            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                  No notifications match the current filters.
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={r.notification_id}>
                <TableCell
                  className="text-xs font-mono"
                  title={r.notification_id}
                >
                  {r.notification_id.slice(0, 8)}
                </TableCell>
                <TableCell className="text-sm">
                  {r.user_name ?? (
                    <span className="text-muted-foreground text-xs" title={r.user_id}>
                      {r.user_id.slice(0, 8)}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-xs">{r.kind}</TableCell>
                <TableCell className="text-xs">
                  <Link
                    to="/referrals/$id"
                    params={{ id: r.referral_id }}
                    className="text-primary hover:underline"
                  >
                    {r.referral_id.slice(0, 8)}
                  </Link>
                  {r.mismatch && r.used_against_referral_id && (
                    <div className="mt-1 text-destructive text-[10px]">
                      used against {r.used_against_referral_id.slice(0, 8)}
                    </div>
                  )}
                </TableCell>
                <TableCell
                  className="whitespace-nowrap text-xs tabular-nums"
                  title={tzTooltip(r.created_at)}
                >
                  {format(new Date(r.created_at), "dd/MM HH:mm:ss")}
                </TableCell>
                <TableCell
                  className="whitespace-nowrap text-xs tabular-nums"
                  title={r.used_at ? tzTooltip(r.used_at) : "Not yet used"}
                >
                  {r.used_at ? (
                    format(new Date(r.used_at), "dd/MM HH:mm:ss")
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell
                  className="whitespace-nowrap text-xs tabular-nums"
                  title={r.read_at ? tzTooltip(r.read_at) : "Unread"}
                >
                  {r.read_at ? (
                    format(new Date(r.read_at), "dd/MM HH:mm:ss")
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell
                  className="whitespace-nowrap text-xs tabular-nums"
                  title={
                    r.expired_at
                      ? r.used_at
                        ? "Expired flag set, but a deep-link click was recorded — see Used column"
                        : tzTooltip(r.expired_at)
                      : "Not expired"
                  }
                >
                  {r.expired_at && !r.used_at ? (
                    <span className="text-warning-foreground">
                      {format(new Date(r.expired_at), "dd/MM HH:mm:ss")}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  {r.mismatch ? (
                    <StatusPill label="mismatch" tone="bad" />
                  ) : r.used_at ? (
                    <StatusPill label={r.read_at ? "used · read" : "used"} tone="ok" />
                  ) : r.expired_at ? (
                    <StatusPill
                      label={`expired ${format(new Date(r.expired_at), "dd/MM HH:mm")}`}
                      tone="warn"
                    />
                  ) : r.read_at ? (
                    <StatusPill label="read · unused" tone="warn" />
                  ) : (
                    <StatusPill label="pending" tone="muted" />
                  )}
                </TableCell>

              </TableRow>
            ))}
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
