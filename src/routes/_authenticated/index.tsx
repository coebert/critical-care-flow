import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, useMemo, useCallback } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Plus, Search, RotateCcw, Trash2, MapPin } from "lucide-react";
import type { Tables } from "@/integrations/supabase/types";
import { format, formatDistanceToNow } from "date-fns";
import { listDeletedReferrals, restoreReferral, RESTORE_WINDOW_DAYS } from "@/lib/referrals.functions";
import { toast } from "sonner";

type Referral = Tables<"referrals">;


export const Route = createFileRoute("/_authenticated/")({
  head: () => ({
    meta: [
      { title: "Referrals — SDH Critical Care" },
      { name: "description", content: "Live list of critical care referrals at Salisbury District Hospital." },
    ],
  }),
  component: ReferralsList,
});

const statusStyles: Record<string, string> = {
  pending: "bg-warning/15 text-warning-foreground border-warning/30",
  admitted: "bg-success/15 text-success border-success/30",
  declined: "bg-destructive/10 text-destructive border-destructive/30",
};

function ReferralsList() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<Referral[]>([]);
  const [loading, setLoading] = useState(true);
  const [hospSearch, setHospSearch] = useState("");
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [locFilter, setLocFilter] = useState<string>("all");
  const [dateFilter, setDateFilter] = useState<"all" | "today" | "yesterday" | "7d" | "30d">("all");
  const [showDeleted, setShowDeleted] = useState(false);
  const [deletedRows, setDeletedRows] = useState<Referral[]>([]);
  const [deletedLoading, setDeletedLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const fetchDeleted = useServerFn(listDeletedReferrals);
  const restoreFn = useServerFn(restoreReferral);

  const loadDeleted = useCallback(async () => {
    setDeletedLoading(true);
    try {
      const data = await fetchDeleted();
      setDeletedRows((data ?? []) as Referral[]);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to load deleted referrals");
    } finally {
      setDeletedLoading(false);
    }
  }, [fetchDeleted]);

  useEffect(() => {
    if (showDeleted) loadDeleted();
  }, [showDeleted, loadDeleted]);

  const onRestore = async (id: string) => {
    setRestoringId(id);
    try {
      await restoreFn({ data: { id } });
      toast.success("Referral restored");
      setDeletedRows((cur) => cur.filter((r) => r.id !== id));
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to restore referral");
    } finally {
      setRestoringId(null);
    }
  };

  useEffect(() => {
    let cancelled = false;

    supabase
      .from("referrals")
      .select("*")
      .is("deleted_at", null)
      .order("referral_received_at", { ascending: false })
      .limit(500)
      .then(({ data }) => {
        if (!cancelled) {
          setRows(data ?? []);
          setLoading(false);
        }
      });


    const ch = supabase
      .channel("referrals-list")
      .on("postgres_changes", { event: "*", schema: "public", table: "referrals" }, (payload) => {
        setRows((cur) => {
          if (payload.eventType === "INSERT") {
            const r = payload.new as Referral;
            return r.deleted_at ? cur : [r, ...cur];
          }
          if (payload.eventType === "UPDATE") {
            const r = payload.new as Referral;
            if (r.deleted_at) return cur.filter((x) => x.id !== r.id);
            return cur.map((x) => (x.id === r.id ? r : x));
          }
          if (payload.eventType === "DELETE") return cur.filter((r) => r.id !== (payload.old as Referral).id);
          return cur;
        });
      })

      .subscribe();
    return () => {
      cancelled = true;
      supabase.removeChannel(ch);
    };
  }, []);

  const topWards = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      if (!r.current_ward) continue;
      counts.set(r.current_ward, (counts.get(r.current_ward) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([ward]) => ward);
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hospNeedle = hospSearch.trim().toLowerCase();
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    let fromTs: number | null = null;
    let toTs: number | null = null;
    if (dateFilter === "today") fromTs = startOfToday;
    else if (dateFilter === "yesterday") { fromTs = startOfToday - 86400000; toTs = startOfToday; }
    else if (dateFilter === "7d") fromTs = now.getTime() - 7 * 86400000;
    else if (dateFilter === "30d") fromTs = now.getTime() - 30 * 86400000;

    return rows.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (locFilter !== "all" && r.current_ward !== locFilter) return false;
      if (fromTs !== null) {
        const t = new Date(r.referral_received_at).getTime();
        if (t < fromTs) return false;
        if (toTs !== null && t >= toTs) return false;
      }
      if (hospNeedle) {
        const hn = (r.hospital_number ?? "").toLowerCase();
        if (!hn.includes(hospNeedle)) return false;
      }
      if (!needle) return true;
      return [r.hospital_number, r.current_ward, r.current_bed, r.referring_specialty, r.reason_for_referral]
        .filter(Boolean)
        .some((v) => v!.toString().toLowerCase().includes(needle));
    });
  }, [rows, q, hospSearch, statusFilter, locFilter, dateFilter]);

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Referrals</h1>
          <p className="text-sm text-muted-foreground">{rows.length} total · live updating</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant={showDeleted ? "default" : "outline"}
            size="sm"
            onClick={() => setShowDeleted((v) => !v)}
          >
            <Trash2 className="w-4 h-4 mr-1" />
            {showDeleted ? "Hide" : "Recently deleted"}
          </Button>
          <Button asChild>
            <Link to="/referrals/new"><Plus className="w-4 h-4 mr-1" /> New referral</Link>
          </Button>
        </div>
      </div>

      {showDeleted && (
        <div className="border rounded-md bg-card overflow-hidden mb-6">
          <div className="px-3 py-2 border-b bg-muted/40 text-sm flex items-center justify-between">
            <span className="font-medium">Recently deleted</span>
            <span className="text-xs text-muted-foreground">
              Restorable within {RESTORE_WINDOW_DAYS} days of deletion
            </span>
          </div>
          <div className="overflow-x-auto"><table className="w-full text-sm min-w-[640px]">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2">Deleted</th>
                <th className="text-left px-3 py-2">Hosp. no</th>
                <th className="text-left px-3 py-2">Location</th>
                <th className="text-left px-3 py-2">Specialty</th>
                <th className="text-left px-3 py-2">Reason</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {deletedLoading && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
              )}
              {!deletedLoading && deletedRows.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">No restorable referrals.</td></tr>
              )}
              {deletedRows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                    {r.deleted_at ? `${formatDistanceToNow(new Date(r.deleted_at))} ago` : "—"}
                  </td>
                  <td className="px-3 py-2">{r.hospital_number ?? "—"}</td>
                  <td className="px-3 py-2">{r.current_ward ?? "—"} {r.current_bed ? `· ${r.current_bed}` : ""}</td>
                  <td className="px-3 py-2">{r.referring_specialty ?? "—"}</td>
                  <td className="px-3 py-2 max-w-xs truncate">{r.reason_for_referral ?? "—"}</td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={restoringId === r.id}
                      onClick={() => onRestore(r.id)}
                    >
                      <RotateCcw className="w-3.5 h-3.5 mr-1" />
                      {restoringId === r.id ? "Restoring…" : "Restore"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      )}


      <div className="flex flex-wrap gap-2 mb-4">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by hospital number…"
            value={hospSearch}
            onChange={(e) => setHospSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search ward, bed, specialty, reason…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-9"
          />
        </div>
        {(["all", "pending", "admitted", "declined"] as const).map((s) => (
          <Button
            key={s}
            size="sm"
            variant={statusFilter === s ? "default" : "outline"}
            onClick={() => setStatusFilter(s)}
            className="capitalize"
          >
            {s}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 mb-4 items-center">
        <span className="text-xs uppercase text-muted-foreground mr-1">Date</span>
        {([
          { k: "all", label: "All time" },
          { k: "today", label: "Today" },
          { k: "yesterday", label: "Yesterday" },
          { k: "7d", label: "Last 7 days" },
          { k: "30d", label: "Last 30 days" },
        ] as const).map(({ k, label }) => (
          <Button
            key={k}
            size="sm"
            variant={dateFilter === k ? "default" : "outline"}
            onClick={() => setDateFilter(k)}
          >
            {label}
          </Button>
        ))}
      </div>

      {topWards.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4 items-center">
          <span className="text-xs uppercase text-muted-foreground mr-1">Location</span>
          <Button
            size="sm"
            variant={locFilter === "all" ? "default" : "outline"}
            onClick={() => setLocFilter("all")}
          >
            All
          </Button>
          {topWards.map((ward) => (
            <Button
              key={ward}
              size="sm"
              variant={locFilter === ward ? "default" : "outline"}
              onClick={() => setLocFilter(ward)}
            >
              <MapPin className="w-3 h-3 mr-1" />
              {ward}
            </Button>
          ))}
        </div>
      )}


      {/* Desktop table */}
      <div className="hidden md:block border rounded-md bg-card overflow-hidden">
        <div className="overflow-x-auto"><table className="w-full text-sm min-w-[720px]">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2">Received</th>
              <th className="text-left px-3 py-2">Hosp. no</th>
              <th className="text-left px-3 py-2">Age/Sex</th>
              <th className="text-left px-3 py-2">Location</th>
              <th className="text-left px-3 py-2">Specialty</th>
              <th className="text-left px-3 py-2">Reason</th>
              <th className="text-left px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">No referrals match.</td></tr>
            )}
            {filtered.map((r) => (
              <tr
                key={r.id}
                className="border-t hover:bg-accent/40 cursor-pointer"
                onClick={() => navigate({ to: "/referrals/$id", params: { id: r.id } })}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    navigate({ to: "/referrals/$id", params: { id: r.id } });
                  }
                }}
              >
                <td className="px-3 py-2 whitespace-nowrap">
                  {format(new Date(r.referral_received_at), "dd MMM HH:mm")}
                </td>
                <td className="px-3 py-2">{r.hospital_number ?? "—"}</td>
                <td className="px-3 py-2">{r.age ?? "?"} / {r.sex ?? "?"}</td>
                <td className="px-3 py-2">{r.current_ward ?? "—"} {r.current_bed ? `· ${r.current_bed}` : ""}</td>
                <td className="px-3 py-2">{r.referring_specialty ?? "—"}</td>
                <td className="px-3 py-2 max-w-xs truncate">{r.reason_for_referral ?? "—"}</td>
                <td className="px-3 py-2">
                  <Badge variant="outline" className={`capitalize ${statusStyles[r.status]}`}>{r.status}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden flex flex-col gap-3">
        {loading && (
          <div className="text-center text-muted-foreground py-8">Loading…</div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="text-center text-muted-foreground py-8">No referrals match.</div>
        )}
        {filtered.map((r) => (
          <div
            key={r.id}
            className="border rounded-lg bg-card p-4 cursor-pointer active:scale-[0.99] transition-transform"
            onClick={() => navigate({ to: "/referrals/$id", params: { id: r.id } })}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground">
                {format(new Date(r.referral_received_at), "dd MMM HH:mm")}
              </span>
              <Badge variant="outline" className={`capitalize text-xs ${statusStyles[r.status]}`}>
                {r.status}
              </Badge>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              <div>
                <span className="text-xs text-muted-foreground block">Hospital No</span>
                <span className="font-medium">{r.hospital_number ?? "—"}</span>
              </div>
              <div>
                <span className="text-xs text-muted-foreground block">Age / Sex</span>
                <span className="font-medium">{r.age ?? "?"} / {r.sex ?? "?"}</span>
              </div>
              <div>
                <span className="text-xs text-muted-foreground block">Location</span>
                <span className="font-medium">{r.current_ward ?? "—"} {r.current_bed ? `· ${r.current_bed}` : ""}</span>
              </div>
              <div>
                <span className="text-xs text-muted-foreground block">Specialty</span>
                <span className="font-medium">{r.referring_specialty ?? "—"}</span>
              </div>
              <div className="col-span-2">
                <span className="text-xs text-muted-foreground block">Reason</span>
                <span className="font-medium line-clamp-2">{r.reason_for_referral ?? "—"}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
