import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, useMemo, useCallback } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Plus, Search, RotateCcw, Trash2 } from "lucide-react";
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
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
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

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
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
      if (fromTs !== null) {
        const t = new Date(r.referral_received_at).getTime();
        if (t < fromTs) return false;
        if (toTs !== null && t >= toTs) return false;
      }
      if (!needle) return true;
      return [r.hospital_number, r.current_ward, r.current_bed, r.referring_specialty, r.reason_for_referral]
        .filter(Boolean)
        .some((v) => v!.toString().toLowerCase().includes(needle));
    });
  }, [rows, q, statusFilter, dateFilter]);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Referrals</h1>
          <p className="text-sm text-muted-foreground">{rows.length} total · live updating</p>
        </div>
        <Button asChild>
          <Link to="/referrals/new"><Plus className="w-4 h-4 mr-1" /> New referral</Link>
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search hospital number, ward, specialty…"
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


      <div className="border rounded-md bg-card overflow-hidden">
        <table className="w-full text-sm">
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
        </table>
      </div>
    </div>
  );
}
