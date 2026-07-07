import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { Users } from "lucide-react";

import { getBedBoard } from "@/lib/beds.functions";
import { getNurseStaffingForDate } from "@/lib/nurse-staffing.functions";
import { computeNurseCapacity, todayIsoDate, type Shift } from "@/lib/nurse-capacity";

function currentShift(now: Date = new Date()): Shift {
  const h = now.getHours();
  return h >= 8 && h < 20 ? "day" : "night";
}

/**
 * Small pill-style badge shown above the referrals list summarising the
 * spare admission capacity for the current shift by level of care, so a
 * clinician can tell at a glance whether accepting a patient at a given
 * level is currently safe. Links to the bed board for the full picture.
 */
export function CapacityBadge() {
  const today = todayIsoDate();
  const shift = currentShift();
  const shiftLabel = shift === "day" ? "Day" : "Night";

  const fetchBoard = useServerFn(getBedBoard);
  const fetchStaffing = useServerFn(getNurseStaffingForDate);

  const board = useQuery({
    queryKey: ["referrals-list-capacity", "board"],
    queryFn: () => fetchBoard(),
    staleTime: 30_000,
  });
  const staffing = useQuery({
    queryKey: ["referrals-list-capacity", "staffing", today],
    queryFn: () => fetchStaffing({ data: { shift_date: today } }),
    staleTime: 30_000,
  });

  const dayAvail =
    (staffing.data ?? []).find((r) => r.shift === "day")?.available_nurses ?? null;
  const nightAvail =
    (staffing.data ?? []).find((r) => r.shift === "night")?.available_nurses ?? null;

  const snap = useMemo(
    () =>
      computeNurseCapacity({
        occupancies: board.data?.occupancies ?? [],
        day_available: dayAvail,
        night_available: nightAvail,
      }),
    [board.data, dayAvail, nightAvail],
  );

  const block = shift === "day" ? snap.day : snap.night;
  const loading = board.isLoading || staffing.isLoading;

  const noStaffing = !loading && block.available == null;

  const Level = ({ label, slots, level }: { label: string; slots: number | null; level: 1 | 2 | 3 }) => {
    const n = slots ?? 0;
    const tone =
      n <= 0
        ? "bg-destructive/10 text-destructive border-destructive/30 hover:bg-destructive/20"
        : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20";
    return (
      <Link
        to="/bed-board"
        search={{ focus_shift: shift, focus_level: level }}
        aria-label={`${label} slots: ${slots ?? "unknown"} — review ${shiftLabel} shift Level ${level} on bed board`}
        className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium tabular-nums transition-colors ${tone}`}
      >
        {label}
        <span className="font-semibold">{slots ?? "—"}</span>
      </Link>
    );
  };

  return (
    <div
      className="inline-flex items-center gap-2 rounded-full border bg-muted/40 px-2 py-1 text-xs"
      aria-label="Current admission capacity by level"
    >
      <Link
        to="/bed-board"
        search={{ focus_shift: shift }}
        aria-label={`Review ${shiftLabel} shift capacity on bed board`}
        className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
      >
        <Users className="w-3.5 h-3.5" aria-hidden="true" />
        <span>{shiftLabel} capacity</span>
      </Link>
      {loading ? (
        <span className="text-muted-foreground">…</span>
      ) : noStaffing ? (
        <span className="text-muted-foreground">no nurse count</span>
      ) : (
        <>
          <Level label="L3" slots={block.level3_slots} level={3} />
          <Level label="L2" slots={block.level2_slots} level={2} />
          <Level label="L1/0" slots={block.level1_slots} level={1} />
          <span className="text-muted-foreground">
            · spare{" "}
            <span
              className={`tabular-nums font-semibold ${
                (block.spare ?? 0) < 0
                  ? "text-destructive"
                  : (block.spare ?? 0) === 0
                    ? "text-amber-700 dark:text-amber-400"
                    : "text-emerald-700 dark:text-emerald-400"
              }`}
            >
              {block.spare?.toFixed(2)}
            </span>
          </span>
        </>
      )}
    </div>
  );
}
