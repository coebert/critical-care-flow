import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { CheckCheck, Inbox as InboxIcon } from "lucide-react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import {
  inboxSearchValidator,
  notificationsQueryOptions,
  NOTIFICATIONS_QUERY_KEY,
  PAGE_SIZE,
  type InboxSearch,
  type Notification,
} from "@/lib/inbox-utils";
import { InboxFilters } from "@/components/inbox/inbox-filters";
import { InboxList } from "@/components/inbox/inbox-list";

function InboxPending() {
  return <div className="p-6 text-sm text-muted-foreground text-center">Loading…</div>;
}
function InboxError({ error }: { error: Error }) {
  return (
    <div className="p-6 text-sm text-destructive" role="alert">
      Could not load notifications: {error.message}
    </div>
  );
}

export const Route = createFileRoute("/_authenticated/inbox")({
  validateSearch: inboxSearchValidator,
  head: () => ({
    meta: [
      { title: "Inbox — SDH Critical Care" },
      { name: "description", content: "Past notifications with read and unread status." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(notificationsQueryOptions),
  pendingComponent: InboxPending,
  errorComponent: InboxError,
  component: InboxPage,
});

export { NOTIFICATIONS_QUERY_KEY };

function InboxPage() {
  const { user } = useAuth();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/inbox" });
  const queryClient = useQueryClient();
  const { data: items } = useSuspenseQuery(notificationsQueryOptions);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [qInput, setQInput] = useState(search.q);

  const patchItems = (updater: (prev: Notification[]) => Notification[]) => {
    queryClient.setQueryData<Notification[]>(NOTIFICATIONS_QUERY_KEY, (cur) =>
      updater(cur ?? []),
    );
  };

  useEffect(() => { setQInput(search.q); }, [search.q]);

  useEffect(() => {
    if (qInput === search.q) return;
    const t = setTimeout(() => {
      navigate({ search: (prev: Record<string, unknown>) => ({ ...prev, q: qInput, page: 1 }) });
    }, 300);
    return () => clearTimeout(t);
  }, [qInput, search.q, navigate]);

  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`inbox-${user.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${user.id}` },
        (payload) => {
          patchItems((cur) => [payload.new as Notification, ...cur]);
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const unreadCount = useMemo(() => items.filter((i) => !i.read_at).length, [items]);

  const filtered = useMemo(() => {
    const q = search.q.trim().toLowerCase();
    const fromTs = search.from ? new Date(search.from + "T00:00:00").getTime() : null;
    const toTs = search.to ? new Date(search.to + "T23:59:59.999").getTime() : null;
    const arr = items.filter((n) => {
      if (search.tab === "unread" && n.read_at) return false;
      if (search.kind !== "all" && n.kind !== search.kind) return false;
      if (q) {
        const hay = `${n.message} ${n.referral_id ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (fromTs || toTs) {
        const t = new Date(n.created_at).getTime();
        if (fromTs && t < fromTs) return false;
        if (toTs && t > toTs) return false;
      }
      return true;
    });
    arr.sort((a, b) => {
      const ta = new Date(a.created_at).getTime();
      const tb = new Date(b.created_at).getTime();
      return search.sort === "oldest" ? ta - tb : tb - ta;
    });
    return arr;
  }, [items, search.tab, search.q, search.kind, search.from, search.to, search.sort]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(search.page, totalPages);
  const pageStart = (page - 1) * PAGE_SIZE;
  const visible = filtered.slice(pageStart, pageStart + PAGE_SIZE);
  const visibleIds = useMemo(() => visible.map((i) => i.id), [visible]);
  const selectedVisible = useMemo(
    () => visibleIds.filter((id) => selected.has(id)),
    [visibleIds, selected],
  );
  const allVisibleSelected = visibleIds.length > 0 && selectedVisible.length === visibleIds.length;
  const someVisibleSelected = selectedVisible.length > 0 && !allVisibleSelected;

  const hasFilters =
    search.q !== "" || search.kind !== "all" || search.from !== "" ||
    search.to !== "" || search.sort !== "newest";

  const toggleOne = (id: string, checked: boolean) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  };
  const toggleAllVisible = (checked: boolean) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (checked) visibleIds.forEach((id) => next.add(id));
      else visibleIds.forEach((id) => next.delete(id));
      return next;
    });
  };
  const clearSelection = () => setSelected(new Set());

  const markRead = async (id: string) => {
    const now = new Date().toISOString();
    patchItems((cur) => cur.map((i) => (i.id === id ? { ...i, read_at: now } : i)));
    const { error } = await supabase.from("notifications").update({ read_at: now }).eq("id", id);
    if (error) toast.error("Could not mark as read");
  };
  const markUnread = async (id: string) => {
    patchItems((cur) => cur.map((i) => (i.id === id ? { ...i, read_at: null } : i)));
    const { error } = await supabase.from("notifications").update({ read_at: null }).eq("id", id);
    if (error) toast.error("Could not mark as unread");
  };
  const markAllRead = async () => {
    const ids = items.filter((i) => !i.read_at).map((i) => i.id);
    if (!ids.length) return;
    setBusy(true);
    const now = new Date().toISOString();
    patchItems((cur) => cur.map((i) => (i.read_at ? i : { ...i, read_at: now })));
    const { error } = await supabase.from("notifications").update({ read_at: now }).in("id", ids);
    setBusy(false);
    if (error) toast.error("Some notifications could not be updated");
    else toast.success(`Marked ${ids.length} as read`);
  };
  const bulkMark = async (asRead: boolean) => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    setBusy(true);
    const now = asRead ? new Date().toISOString() : null;
    patchItems((cur) => cur.map((i) => (selected.has(i.id) ? { ...i, read_at: now } : i)));
    const { error } = await supabase.from("notifications").update({ read_at: now }).in("id", ids);
    setBusy(false);
    if (error) toast.error("Some notifications could not be updated");
    else {
      toast.success(`Marked ${ids.length} as ${asRead ? "read" : "unread"}`);
      clearSelection();
    }
  };

  const setSearch = (patch: Partial<InboxSearch>) => {
    navigate({ search: (prev: Record<string, unknown>) => ({ ...prev, ...patch, page: patch.page ?? 1 }) });
  };
  const clearFilters = () => {
    setQInput("");
    navigate({ search: (prev: Record<string, unknown>) => ({ ...prev, q: "", kind: "all", from: "", to: "", sort: "newest", page: 1 }) });
  };

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <InboxIcon className="w-5 h-5" aria-hidden="true" /> Inbox
          </h1>
          <p className="text-sm text-muted-foreground">
            {unreadCount > 0 ? `${unreadCount} unread` : "All caught up"}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={markAllRead} disabled={busy || unreadCount === 0}>
          <CheckCheck className="w-4 h-4 mr-1" aria-hidden="true" /> Mark all read
        </Button>
      </div>

      <InboxFilters
        qInput={qInput}
        setQInput={setQInput}
        search={search}
        filteredCount={filtered.length}
        hasFilters={hasFilters}
        setSearch={setSearch}
        clearFilters={clearFilters}
      />

      <Tabs
        value={search.tab}
        onValueChange={(v) => { setSearch({ tab: v as "all" | "unread" }); clearSelection(); }}
      >
        <TabsList>
          <TabsTrigger value="all">All ({items.length})</TabsTrigger>
          <TabsTrigger value="unread">Unread ({unreadCount})</TabsTrigger>
        </TabsList>
        <TabsContent value={search.tab} className="mt-3 space-y-2">
          <InboxList
            loading={false}
            busy={busy}
            visible={visible}
            filteredCount={filtered.length}
            page={page}
            totalPages={totalPages}
            pageStart={pageStart}
            hasFilters={hasFilters}
            tab={search.tab}
            selected={selected}
            visibleIds={visibleIds}
            allVisibleSelected={allVisibleSelected}
            someVisibleSelected={someVisibleSelected}
            toggleOne={toggleOne}
            toggleAllVisible={toggleAllVisible}
            clearSelection={clearSelection}
            bulkMark={bulkMark}
            markRead={markRead}
            markUnread={markUnread}
            setPage={(p) => setSearch({ page: p })}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
