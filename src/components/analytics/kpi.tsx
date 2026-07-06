import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-5">
      <div className="text-xs text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </Card>
  );
}

export function IcnarcKpi({
  label,
  targetLabel,
  pct,
  median,
  n,
}: {
  label: string;
  targetLabel: string;
  pct: number;
  median: number;
  n: number;
}) {
  const tone =
    n === 0 ? "text-muted-foreground"
    : pct >= 90 ? "text-success"
    : pct >= 70 ? "text-warning-foreground"
    : "text-destructive";
  const barTone =
    pct >= 90 ? "bg-success"
    : pct >= 70 ? "bg-warning"
    : "bg-destructive";
  const fmtMedian = median >= 60 ? `${(median / 60).toFixed(1)} h` : `${Math.round(median)} min`;
  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-sm font-medium">{label}</div>
        <Badge variant="outline" className="shrink-0">Target {targetLabel}</Badge>
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className={cn("text-3xl font-semibold tabular-nums", tone)}>
          {n ? `${pct.toFixed(0)}%` : "—"}
        </span>
        <span className="text-xs text-muted-foreground">within target</span>
      </div>
      <div className="mt-3 h-2 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={cn("h-full transition-all", barTone)}
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>
      <div className="mt-3 flex justify-between text-xs text-muted-foreground">
        <span>Median {n ? fmtMedian : "—"}</span>
        <span>n = {n}</span>
      </div>
    </div>
  );
}
