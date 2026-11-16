import { Link } from "@tanstack/react-router";
import { Bed as BedIcon, ArrowRight } from "lucide-react";
import { useUnitCapacity } from "@/hooks/use-unit-capacity";
import { CapacityFreshness, countTone } from "@/components/capacity/capacity-status";

/**
 * Compact physical-occupancy summary from the live ICU Handover Hub roster
 * (shared cache with the Bed Board). Occupied beds with withheld details
 * count as occupied.
 */
export function MiniCapacityLink() {
  const view = useUnitCapacity();
  const { physical } = view.derivation;
  const unit = view.board?.unit ?? "Unit";

  return (
    <div className="inline-flex flex-wrap items-center gap-2 rounded-md border bg-card px-3 py-1.5 text-sm max-w-full">
      <Link
        to="/bed-board"
        className="inline-flex flex-wrap items-center gap-2 min-h-8 hover:underline underline-offset-2"
        aria-label={
          physical
            ? `Open bed board — ${physical.vacant} of ${physical.total} beds free${view.reassuring ? "" : " (not current)"}`
            : "Open bed board — occupancy unavailable"
        }
      >
        <BedIcon className="w-4 h-4 text-muted-foreground" aria-hidden="true" />
        <span className="font-medium">Beds</span>
        {physical ? (
          <>
            <span className={`border rounded-md px-2 py-0.5 text-xs tabular-nums ${countTone(physical.vacant, view.reassuring)}`}>
              {unit}: {physical.vacant}/{physical.total} free
            </span>
            {physical.withheld > 0 && (
              <span className="text-xs text-muted-foreground">
                · {physical.withheld} occupied (details withheld)
              </span>
            )}
            {physical.unassigned > 0 && (
              <span className="text-xs text-muted-foreground">
                · {physical.unassigned} awaiting a bed
              </span>
            )}
          </>
        ) : (
          <span className="text-xs text-muted-foreground">
            {view.latestFailure ? "occupancy unavailable" : "loading…"}
          </span>
        )}
        <ArrowRight className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
      </Link>
      <CapacityFreshness view={view} compact className="text-xs" />
    </div>
  );
}
