import { Link } from "@tanstack/react-router";
import { Bed as BedIcon, Users } from "lucide-react";

import { useUnitCapacity } from "@/hooks/use-unit-capacity";
import { shiftName } from "@/lib/shift-clock";
import { CapacityFreshness, TONE, countTone } from "@/components/capacity/capacity-status";

/**
 * Pill summarising current-shift capacity above the referrals list. Uses the
 * same live ICU Handover Hub occupancy + CCC acuity + staffing as the Bed
 * Board (useUnitCapacity). Physical beds and nursing room are shown
 * separately; unknown / stale inputs are labelled, never shown as room.
 */
export function CapacityBadge() {
  const view = useUnitCapacity();
  const { shift, derivation, reassuring } = view;
  const { physical, nursing } = derivation;
  const label = shiftName(shift.shift).replace(" shift", "");

  const Level = ({ text, slots, level }: { text: string; slots: number; level: 1 | 2 | 3 }) => (
    <Link
      to="/bed-board"
      search={{ focus_shift: shift.shift, focus_level: level }}
      aria-label={`${text}: room for ${slots} by nursing${reassuring ? "" : " (not current)"} — review on bed board`}
      className={`inline-flex items-center gap-1 rounded-full border px-2 min-h-8 text-xs font-medium tabular-nums hover:opacity-90 ${countTone(slots, reassuring)}`}
    >
      {text}
      <span className="font-semibold">{slots}</span>
    </Link>
  );

  return (
    <div
      className="inline-flex flex-wrap items-center gap-1.5 rounded-2xl border bg-muted/40 px-2 py-1 text-xs max-w-full"
      role="group"
      aria-label={`${label} shift admission capacity`}
    >
      <Link
        to="/bed-board"
        search={{ focus_shift: shift.shift }}
        aria-label={`Review ${label.toLowerCase()} shift capacity on bed board`}
        className="inline-flex items-center gap-1.5 min-h-8 px-1 text-muted-foreground hover:text-foreground"
      >
        <Users className="w-3.5 h-3.5" aria-hidden="true" />
        <span>{label} capacity</span>
      </Link>

      {physical ? (
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 min-h-8 tabular-nums ${countTone(physical.vacant, reassuring)}`}
          title={physical.withheld ? `${physical.withheld} occupied bed(s) with details withheld` : undefined}
        >
          <BedIcon className="w-3.5 h-3.5" aria-hidden="true" />
          Beds free <span className="font-semibold">{physical.vacant}/{physical.total}</span>
        </span>
      ) : null}

      {nursing.state === "ok" ? (
        <>
          <span className="sr-only">Nursing room:</span>
          <Level text="L3" slots={nursing.level3_slots ?? 0} level={3} />
          <Level text="L2" slots={nursing.level2_slots ?? 0} level={2} />
          <Level text="L1/0" slots={nursing.level1_slots ?? 0} level={1} />
        </>
      ) : nursing.state === "no_staffing" ? (
        <span className={`rounded-full border px-2 min-h-8 inline-flex items-center ${TONE.warn}`}>
          No nurse count for this shift
        </span>
      ) : nursing.reason === "loading" ? (
        <span className="text-muted-foreground px-1">Loading…</span>
      ) : (
        <span
          className={`rounded-full border px-2 min-h-8 inline-flex items-center ${TONE.warn}`}
          title={nursing.message}
        >
          Nursing room unknown
        </span>
      )}

      <CapacityFreshness view={view} compact />
    </div>
  );
}
