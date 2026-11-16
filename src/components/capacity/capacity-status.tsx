import { formatDistanceStrict } from "date-fns";
import { AlertTriangle, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { UnitCapacityView } from "@/hooks/use-unit-capacity";
import { formatUnitTime } from "@/lib/shift-clock";

export const TONE = {
  good: "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 border-emerald-500/30",
  bad: "bg-destructive/10 text-destructive border-destructive/30",
  warn: "bg-amber-500/10 text-amber-900 dark:text-amber-200 border-amber-500/40",
  neutral: "bg-muted text-muted-foreground border-border",
} as const;

/** Tone for a count that is reassuring when > 0. Never green unless the view is reassuring. */
export function countTone(n: number, reassuring: boolean): string {
  if (n <= 0) return TONE.bad;
  return reassuring ? TONE.good : TONE.neutral;
}

export function ageText(iso: string | null, now: Date): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return null;
  return formatDistanceStrict(t, now, { addSuffix: true });
}

/** Plain-language reason the latest refresh failed. */
export function failureText(view: Pick<UnitCapacityView, "latestFailure">): string | null {
  const f = view.latestFailure;
  if (!f) return null;
  if (f.forbidden) return f.error;
  if (f.partner_outage) return "ICU Handover Hub is unavailable";
  if (f.indeterminate) return "ICU Handover Hub could not confirm occupancy";
  return "Bed board did not refresh";
}

/**
 * One line of freshness text + a refresh button, shared by every capacity
 * surface. Delayed data is always labelled "not current" with its time.
 */
export function CapacityFreshness({
  view,
  compact = false,
  className = "",
}: {
  view: UnitCapacityView;
  compact?: boolean;
  className?: string;
}) {
  const { freshness, lastSuccessAt, now, isFetching } = view;
  const at = formatUnitTime(lastSuccessAt, now);
  const ago = ageText(lastSuccessAt, now);
  const reason = failureText(view);

  let text: string;
  if (freshness === "current") text = compact ? `Live · ${at}` : `Live · updated ${at}`;
  else if (freshness === "stale")
    text = `Not current — last refreshed ${at}${ago ? ` (${ago})` : ""}`;
  else if (reason) text = reason;
  else text = "Loading…";

  const warn = freshness !== "current" && !(freshness === "none" && !reason);

  return (
    <span className={`inline-flex items-center gap-1.5 flex-wrap ${className}`}>
      <span
        className={warn ? "inline-flex items-center gap-1 font-medium text-amber-900 dark:text-amber-200" : "text-muted-foreground"}
        role={warn ? "status" : undefined}
      >
        {warn && <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
        {text}
        {freshness === "stale" && reason && !compact ? ` · ${reason}` : ""}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 min-w-8 px-2"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          view.refresh();
        }}
        disabled={isFetching}
        aria-label={isFetching ? "Refreshing capacity" : "Refresh capacity now"}
        title="Refresh now"
      >
        <RefreshCcw className={`w-3.5 h-3.5 ${isFetching ? "motion-safe:animate-spin" : ""}`} aria-hidden="true" />
        {!compact && <span className="ml-1 text-xs">Refresh</span>}
      </Button>
    </span>
  );
}
