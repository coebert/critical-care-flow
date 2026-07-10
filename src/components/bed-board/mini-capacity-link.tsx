import { useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getCapacitySnapshot } from "@/lib/beds.functions";
import { supabase } from "@/integrations/supabase/client";
import { Bed as BedIcon, ArrowRight } from "lucide-react";

const QK = ["bed-capacity-snapshot"] as const;

function chip(free: number, total: number) {
  const tone =
    free === 0
      ? "bg-destructive/10 text-destructive border-destructive/30"
      : free <= 1
      ? "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30"
      : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30";
  return `border ${tone} rounded-md px-2 py-0.5 text-xs tabular-nums`;
}

export function MiniCapacityLink() {
  const qc = useQueryClient();
  const fetchSnap = useServerFn(getCapacitySnapshot);
  const { data } = useQuery({
    queryKey: QK,
    queryFn: () => fetchSnap(),
    staleTime: 15_000,
  });

  useEffect(() => {
    const ch = supabase
      .channel("bed-capacity-mini")
      .on("postgres_changes", { event: "*", schema: "public", table: "bed_occupancies" }, () =>
        qc.invalidateQueries({ queryKey: QK }),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "beds" }, () =>
        qc.invalidateQueries({ queryKey: QK }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [qc]);

  if (!data) return null;
  const { icu, hdu, outliers_count, open_transfers_count } = data;

  return (
    <Link
      to="/bed-board"
      className="inline-flex items-center gap-2 rounded-md border bg-card px-3 py-1.5 text-sm hover:bg-accent transition-colors"
      aria-label="Open bed board"
    >
      <BedIcon className="w-4 h-4 text-muted-foreground" aria-hidden="true" />
      <span className="font-medium">Capacity</span>
      <span className={chip(icu.free, icu.total)}>Radnor {icu.free}/{icu.total}</span>
      {hdu.total > 0 && <span className={chip(hdu.free, hdu.total)}>HDU {hdu.free}/{hdu.total}</span>}
      {outliers_count > 0 && (
        <span className="text-xs text-muted-foreground">· {outliers_count} outlier{outliers_count === 1 ? "" : "s"}</span>
      )}
      {open_transfers_count > 0 && (
        <span className="text-xs text-muted-foreground">· {open_transfers_count} transfer{open_transfers_count === 1 ? "" : "s"} out</span>
      )}
      <ArrowRight className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
    </Link>
  );
}
