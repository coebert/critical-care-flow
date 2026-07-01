import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Bell, Check, CheckCheck, ExternalLink, Inbox as InboxIcon, Search, X, ChevronLeft, ChevronRight, ArrowUpDown } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";

const KIND_VALUES = ["all", "new", "status", "note", "updated", "warning"] as const;
const PAGE_SIZE = 25;

const inboxSearchSchema = z.object({
  tab: fallback(z.enum(["all", "unread"]), "all").default("all"),
  q: fallback(z.string(), "").default(""),
  kind: fallback(z.enum(KIND_VALUES), "all").default("all"),
  from: fallback(z.string(), "").default(""),
  to: fallback(z.string(), "").default(""),
  sort: fallback(z.enum(["newest", "oldest"]), "newest").default("newest"),
  page: fallback(z.number().int().min(1), 1).default(1),
});

export const Route = createFileRoute("/_authenticated/inbox")({
  validateSearch: zodValidator(inboxSearchSchema),
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
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/inbox" });
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [qInput, setQInput] = useState(search.q);

  // Keep local input in sync when URL changes externally (back/forward)
  useEffect(() => { setQInput(search.q); }, [search.q]);

  // Debounce q input into URL
  useEffect(() => {
    if (qInput === search.q) return;
    const t = setTimeout(() => {
      navigate({ search: (prev: Record<string, unknown>) => ({ ...prev, q: qInput, page: 1 }) });
    }, 300);
    return () => clearTimeout(t);
  }, [qInput, search.q, navigate]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoading(true);
    supabase
      .from("notifications")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500)
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

  const hasFilters = search.q !== "" || search.kind !== "all" || search.from !== "" || search.to !== "" || search.sort !== "newest";

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
  const bulkMark = async (asRead: boolean) => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    setBusy(true);
    const now = asRead ? new Date().toISOString() : null;
    setItems((cur) => cur.map((i) => (selected.has(i.id) ? { ...i, read_at: now } : i)));
    const { error } = await supabase.from("notifications").update({ read_at: now }).in("id", ids);
    setBusy(false);
    if (error) toast.error("Some notifications could not be updated");
    else {
      toast.success(`Marked ${ids.length} as ${asRead ? "read" : "unread"}`);
      clearSelection();
    }
  };

  const setSearch = (patch: Partial<z.infer<typeof inboxSearchSchema>>) => {
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

      <Card className="p-3 space-y-3">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-muted-foreground" />
          <Input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="Search by message or referral ID…"
            className="pl-8 pr-8"
            aria-label="Search notifications"
          />
          {qInput && (
            <button
              type="button"
              onClick={() => setQInput("")}
              className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          <div>
            <Label className="text-xs">Type</Label>
            <Select value={search.kind} onValueChange={(v) => setSearch({ kind: v as typeof search.kind })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                <SelectItem value="new">New referral</SelectItem>
                <SelectItem value="status">Status change</SelectItem>
                <SelectItem value="note">New note</SelectItem>
                <SelectItem value="updated">Referral updated</SelectItem>
                <SelectItem value="warning">Warning</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="from" className="text-xs">From</Label>
            <Input id="from" type="date" value={search.from} onChange={(e) => setSearch({ from: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="to" className="text-xs">To</Label>
            <Input id="to" type="date" value={search.to} onChange={(e) => setSearch({ to: e.target.value })} />
          </div>
          <div>
            <Label className="text-xs">Sort</Label>
            <Select value={search.sort} onValueChange={(v) => setSearch({ sort: v as "newest" | "oldest" })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">Newest first</SelectItem>
                <SelectItem value="oldest">Oldest first</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {hasFilters && (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{filtered.length} match{filtered.length === 1 ? "" : "es"}</span>
            <Button variant="ghost" size="sm" className="h-7" onClick={clearFilters}>
              <X className="w-3 h-3 mr-1" /> Clear filters
            </Button>
          </div>
        )}
      </Card>

      <Tabs
        value={search.tab}
        onValueChange={(v) => { setSearch({ tab: v as "all" | "unread" }); clearSelection(); }}
      >
        <TabsList>
          <TabsTrigger value="all">All ({items.length})</TabsTrigger>
          <TabsTrigger value="unread">Unread ({unreadCount})</TabsTrigger>
        </TabsList>
        <TabsContent value={search.tab} className="mt-3 space-y-2">
          {visible.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap px-1">
              <Checkbox
                id="select-all-visible"
                checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
                onCheckedChange={(c) => toggleAllVisible(c === true)}
                aria-label="Select all visible notifications"
              />
              <label htmlFor="select-all-visible" className="text-sm text-muted-foreground cursor-pointer">
                {selected.size > 0 ? `${selected.size} selected` : "Select page"}
              </label>
              {selected.size > 0 && (
                <div className="flex items-center gap-2 ml-auto">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => bulkMark(true)}>
                    <Check className="w-4 h-4 mr-1" /> Mark read
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => bulkMark(false)}>
                    Mark unread
                  </Button>
                  <Button size="sm" variant="ghost" onClick={clearSelection} aria-label="Clear selection">
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              )}
            </div>
          )}
          <Card className="divide-y">
            {loading ? (
              <div className="p-6 text-sm text-muted-foreground text-center">Loading…</div>
            ) : visible.length === 0 ? (
              <div className="p-8 text-sm text-muted-foreground text-center flex flex-col items-center gap-2">
                <Bell className="w-6 h-6 opacity-50" />
                {hasFilters ? "No notifications match your filters" : search.tab === "unread" ? "No unread notifications" : "No notifications yet"}
              </div>
            ) : (
              visible.map((n) => {
                const isChecked = selected.has(n.id);
                const rowClass = `flex items-start gap-3 p-3 hover:bg-accent ${!n.read_at ? "bg-accent/40" : ""}`;
                return (
                  <div key={n.id} className={rowClass}>
                    <div className="pt-1" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={isChecked}
                        onCheckedChange={(c) => toggleOne(n.id, c === true)}
                        aria-label={`Select notification ${n.message}`}
                      />
                    </div>
                    <Link to="/inbox/$id" params={{ id: n.id }} className="flex items-start gap-3 flex-1 min-w-0">
                      <div className="mt-1">
                        <span
                          className={`inline-block w-2 h-2 rounded-full ${n.read_at ? "bg-muted-foreground/30" : "bg-primary"}`}
                          aria-label={n.read_at ? "Read" : "Unread"}
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant="secondary" className="text-[10px]">{kindLabel(n.kind)}</Badge>
                          <span className="text-xs text-muted-foreground">
                            {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
                          </span>
                        </div>
                        <div className="text-sm mt-1 break-words">{n.message}</div>
                        <div className="flex items-center gap-2 mt-2">
                          {n.read_at ? (
                            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs"
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); markUnread(n.id); }}>
                              Mark unread
                            </Button>
                          ) : (
                            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs"
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); markRead(n.id); }}>
                              <Check className="w-3 h-3 mr-1" /> Mark read
                            </Button>
                          )}
                        </div>
                      </div>
                    </Link>
                    {n.referral_id && (
                      <div className="pt-1">
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0"
                          title="Open referral"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!n.read_at) markRead(n.id);
                            navigate({ to: "/referrals/$id", params: { id: n.referral_id! } });
                          }}>
                          <ExternalLink className="w-4 h-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </Card>
          {filtered.length > 0 && (
            <div className="flex items-center justify-between text-sm text-muted-foreground pt-1">
              <span>
                {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, filtered.length)} of {filtered.length}
              </span>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" disabled={page <= 1}
                  onClick={() => setSearch({ page: page - 1 })}>
                  <ChevronLeft className="w-4 h-4" /> Prev
                </Button>
                <span className="px-2">Page {page} / {totalPages}</span>
                <Button variant="outline" size="sm" disabled={page >= totalPages}
                  onClick={() => setSearch({ page: page + 1 })}>
                  Next <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
