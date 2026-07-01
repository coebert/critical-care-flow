import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Bell, Check, CheckCheck, Inbox as InboxIcon } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/inbox")({
  head: () => ({
    meta: [
      { title: "Inbox — SDH Critical Care" },
      { name: "description", content: "Past notifications with read and unread status." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: InboxPage,
});

interface Notification {
  id: string;
  referral_id: string | null;
  kind: string;
  message: string;
  read_at: string | null;
  created_at: string;
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "new": return "New referral";
    case "status": return "Status change";
    case "note": return "New note";
    case "updated": return "Referral updated";
    case "warning": return "Warning";
    default: return kind;
  }
}

function InboxPage() {
  const { user } = useAuth();
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"all" | "unread">("all");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoading(true);
    supabase
      .from("notifications")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) toast.error("Could not load notifications");
        setItems(data ?? []);
        setLoading(false);
      });

    const channel = supabase
      .channel(`inbox-${user.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${user.id}` },
        (payload) => {
          setItems((cur) => [payload.new as Notification, ...cur]);
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [user]);

  const unreadCount = useMemo(() => items.filter((i) => !i.read_at).length, [items]);
  const visible = tab === "unread" ? items.filter((i) => !i.read_at) : items;

  const markRead = async (id: string) => {
    const now = new Date().toISOString();
    setItems((cur) => cur.map((i) => (i.id === id ? { ...i, read_at: now } : i)));
    const { error } = await supabase.from("notifications").update({ read_at: now }).eq("id", id);
    if (error) toast.error("Could not mark as read");
  };

  const markUnread = async (id: string) => {
    setItems((cur) => cur.map((i) => (i.id === id ? { ...i, read_at: null } : i)));
    const { error } = await supabase.from("notifications").update({ read_at: null }).eq("id", id);
    if (error) toast.error("Could not mark as unread");
  };

  const markAllRead = async () => {
    const ids = items.filter((i) => !i.read_at).map((i) => i.id);
    if (!ids.length) return;
    setBusy(true);
    const now = new Date().toISOString();
    setItems((cur) => cur.map((i) => (i.read_at ? i : { ...i, read_at: now })));
    const { error } = await supabase.from("notifications").update({ read_at: now }).in("id", ids);
    setBusy(false);
    if (error) toast.error("Some notifications could not be updated");
    else toast.success(`Marked ${ids.length} as read`);
  };

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <InboxIcon className="w-5 h-5" /> Inbox
          </h1>
          <p className="text-sm text-muted-foreground">
            {unreadCount > 0 ? `${unreadCount} unread` : "All caught up"}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={markAllRead} disabled={busy || unreadCount === 0}>
          <CheckCheck className="w-4 h-4 mr-1" /> Mark all read
        </Button>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "all" | "unread")}>
        <TabsList>
          <TabsTrigger value="all">All ({items.length})</TabsTrigger>
          <TabsTrigger value="unread">Unread ({unreadCount})</TabsTrigger>
        </TabsList>
        <TabsContent value={tab} className="mt-3">
          <Card className="divide-y">
            {loading ? (
              <div className="p-6 text-sm text-muted-foreground text-center">Loading…</div>
            ) : visible.length === 0 ? (
              <div className="p-8 text-sm text-muted-foreground text-center flex flex-col items-center gap-2">
                <Bell className="w-6 h-6 opacity-50" />
                {tab === "unread" ? "No unread notifications" : "No notifications yet"}
              </div>
            ) : (
              visible.map((n) => {
                const content = (
                  <>
                    <div className="mt-1">
                      <span
                        className={`inline-block w-2 h-2 rounded-full ${
                          n.read_at ? "bg-muted-foreground/30" : "bg-primary"
                        }`}
                        aria-label={n.read_at ? "Read" : "Unread"}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="secondary" className="text-[10px]">
                          {kindLabel(n.kind)}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
                        </span>
                        {n.referral_id && (
                          <span className="text-xs text-primary ml-auto">Open referral →</span>
                        )}
                      </div>
                      <div className="text-sm mt-1 break-words">{n.message}</div>
                      <div className="flex items-center gap-2 mt-2">
                        {n.read_at ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              markUnread(n.id);
                            }}
                          >
                            Mark unread
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              markRead(n.id);
                            }}
                          >
                            <Check className="w-3 h-3 mr-1" /> Mark read
                          </Button>
                        )}
                      </div>
                    </div>
                  </>
                );

                const rowClass = `flex items-start gap-3 p-3 ${
                  !n.read_at ? "bg-accent/40" : ""
                } ${n.referral_id ? "hover:bg-accent cursor-pointer" : ""}`;

                if (n.referral_id) {
                  return (
                    <Link
                      key={n.id}
                      to="/referrals/$id"
                      params={{ id: n.referral_id }}
                      onClick={() => {
                        if (!n.read_at) markRead(n.id);
                      }}
                      className={rowClass}
                    >
                      {content}
                    </Link>
                  );
                }
                return (
                  <div key={n.id} className={rowClass}>
                    {content}
                  </div>
                );
              })
            )}
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
