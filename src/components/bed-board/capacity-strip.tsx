import { Badge } from "@/components/ui/badge";
import type { CapacitySnapshot } from "@/lib/bed-capacity";
import { AlertTriangle, ArrowRightLeft, Bed as BedIcon } from "lucide-react";

function UnitBlock({ label, counts }: { label: string; counts: CapacitySnapshot["icu"] }) {
  const tone =
    counts.free === 0 ? "bg-destructive/10 text-destructive border-destructive/30" :
    counts.free <= 1 ? "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30" :
    "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30";
  return (
    <div className={`flex items-center gap-2 rounded-md border px-3 py-1.5 ${tone}`}>
      <BedIcon className="w-4 h-4" aria-hidden="true" />
      <div className="text-sm font-semibold">{label}</div>
      <div className="text-sm tabular-nums">
        {counts.occupied}/{counts.total}
      </div>
      <div className="text-xs text-muted-foreground tabular-nums">
        · {counts.free} free
      </div>
      {counts.predicted_free_in_24h > counts.free && (
        <div className="text-xs text-muted-foreground tabular-nums">
          · +{counts.predicted_free_in_24h - counts.free} in 24h
        </div>
      )}
    </div>
  );
}

export function CapacityStrip({ snapshot }: { snapshot: CapacitySnapshot }) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-4" role="status" aria-label="Unit capacity">
      <UnitBlock label="Radnor CCU" counts={snapshot.icu} />
      {snapshot.hdu.total > 0 && <UnitBlock label="HDU" counts={snapshot.hdu} />}
      {snapshot.outliers_count > 0 && (
        <Badge variant="outline" className="gap-1">
          <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
          {snapshot.outliers_count} outlier{snapshot.outliers_count === 1 ? "" : "s"}
        </Badge>
      )}
      {snapshot.open_transfers_count > 0 && (
        <Badge variant="outline" className="gap-1">
          <ArrowRightLeft className="w-3.5 h-3.5" aria-hidden="true" />
          {snapshot.open_transfers_count} transfer{snapshot.open_transfers_count === 1 ? "" : "s"} out
        </Badge>
      )}
    </div>
  );
}
