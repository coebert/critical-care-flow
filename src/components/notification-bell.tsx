import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { formatDistanceToNow } from "date-fns";


interface Notification {
  id: string;
  referral_id: string | null;
  kind: string;
  message: string;
  read_at: string | null;
  created_at: string;
}

export function NotificationBell() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [items, setItems] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);


  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    supabase
      .from("notifications")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(30)
      .then(({ data }) => {
        if (!cancelled && data) setItems(data);
      });

    const channel = supabase
      .channel(`notif-${user.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${user.id}` },
        (payload) => {
          const n = payload.new as Notification;
          setItems((cur) => [n, ...cur].slice(0, 30));

          // Brand every in-app alert with the unit name so a user glancing
          // at a toast or a background OS notification always knows which
          // service the alert is from. Matches the push-title branding in
          // notification-fanout.ts and sw-push.js.
          const kindLabel =
            n.kind === "new"
              ? "New referral"
              : n.kind === "status"
              ? "Referral status changed"
              : n.kind === "note"
              ? "New referral note"
              : "Referral updated";
          const title = `Radnor Critical Care — ${kindLabel}`;

          // In-app toast when the tab is visible; native browser notification
          // when it isn't (so users still get notified when app is backgrounded).
          if (typeof document !== "undefined" && document.visibilityState === "visible") {
            toast(title, {
              description: n.message,
              action: n.referral_id
                ? {
                    label: "Open",
                    onClick: () =>
                      navigate({ to: "/referrals/$id", params: { id: n.referral_id! } }),
                  }
                : undefined,
            });
          } else if (
            typeof window !== "undefined" &&
            "Notification" in window &&
            Notification.permission === "granted"
          ) {
            new Notification(title, { body: n.message });
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "notifications", filter: `user_id=eq.${user.id}` },
        (payload) => {
          const n = payload.new as Notification;
          setItems((cur) => {
            const idx = cur.findIndex((i) => i.id === n.id);
            if (idx === -1) return cur;
            const next = cur.slice();
            next[idx] = { ...next[idx], read_at: n.read_at };
            return next;
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "notifications", filter: `user_id=eq.${user.id}` },
        (payload) => {
          const oldId = (payload.old as { id?: string }).id;
          if (!oldId) return;
          setItems((cur) => cur.filter((i) => i.id !== oldId));
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [user]);

  const unread = items.filter((i) => !i.read_at).length;

  const markAllRead = async () => {
    const ids = items.filter((i) => !i.read_at).map((i) => i.id);
    if (!ids.length) return;
    setMarkingAll(true);
    const now = new Date().toISOString();
    // Optimistic: flip local state, then persist. On failure, roll back
    // and surface a toast so the badge count is trustworthy.
    const prev = items;
    setItems((cur) => cur.map((i) => (i.read_at ? i : { ...i, read_at: now })));
    const { error } = await supabase
      .from("notifications")
      .update({ read_at: now })
      .in("id", ids);
    setMarkingAll(false);
    if (error) {
      setItems(prev);
      toast.error("Could not mark all as read");
      return;
    }
    // Refresh the referrals-list unread badge (and any other consumers
    // of these query keys) so the count updates immediately, not after
    // the realtime UPDATE round-trips.
    queryClient.invalidateQueries({ queryKey: ["referrals", "unreadCounts"] });
    queryClient.invalidateQueries({ queryKey: ["notifications"] });
    toast.success(`Marked ${ids.length} as read`);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}>
          <Bell className="w-5 h-5" />
          {unread > 0 && (
            <span
              className="absolute top-1 right-1 min-w-4 h-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-semibold flex items-center justify-center"
              aria-hidden="true"
            >
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between p-3 border-b">
          <div className="text-sm font-semibold">
            Notifications{unread > 0 ? ` · ${unread} unread` : ""}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={markAllRead}
            disabled={unread === 0 || markingAll}
          >
            {markingAll ? "Marking…" : "Mark all read"}
          </Button>
        </div>

        <div className="max-h-96 overflow-auto">
          {items.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground text-center">No notifications yet</div>
          ) : (
            items.map((n) => (
              <Link
                key={n.id}
                to={n.referral_id ? "/referrals/$id" : "/"}
                params={n.referral_id ? { id: n.referral_id } : undefined as any}
                onClick={() => setOpen(false)}
                className={`block px-3 py-2 border-b last:border-0 hover:bg-accent ${!n.read_at ? "bg-accent/40" : ""}`}
              >
                <div className="text-sm">{n.message}</div>
                <div className="text-xs text-muted-foreground">
                  {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
                </div>
              </Link>
            ))
          )}
        </div>
        <div className="p-2 border-t text-center">
          <Link
            to="/inbox"
            onClick={() => setOpen(false)}
            className="text-xs text-primary hover:underline"
          >
            View all notifications
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
