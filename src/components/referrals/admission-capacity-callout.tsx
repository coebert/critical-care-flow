import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Users } from "lucide-react";
import { Link } from "@tanstack/react-router";

import { getBedBoard } from "@/lib/beds.functions";
import { getNurseStaffingForDate } from "@/lib/nurse-staffing.functions";
import { computeNurseCapacity, todayIsoDate, type Shift } from "@/lib/nurse-capacity";

function currentShift(now: Date = new Date()): Shift {
  const h = now.getHours();
  return h >= 8 && h < 20 ? "day" : "night";
}

/**
 * Compact read-only callout showing the currently computed admission
 * capacity for the shift now in progress. Used on the referral
 * edit/accept screen so the decision-maker sees whether the unit has
 * nursing room for another patient at each level of care.
 */
export function AdmissionCapacityCallout() {
  const today = todayIsoDate();
  const shift: Shift = currentShift();

  const fetchBoard = useServerFn(getBedBoard);
  const fetchStaffing = useServerFn(getNurseStaffingForDate);

  const board = useQuery({
    queryKey: ["referral-capacity", "board"],
    queryFn: () => fetchBoard(),
    staleTime: 30_000,
  });
  const staffing = useQuery({
    queryKey: ["referral-capacity", "staffing", today],
    queryFn: () => fetchStaffing({ data: { shift_date: today } }),
    staleTime: 30_000,
  });

  const dayAvail =
    (staffing.data ?? []).find((r) => r.shift === "day")?.available_nurses ?? null;
  const nightAvail =
    (staffing.data ?? []).find((r) => r.shift === "night")?.available_nurses ?? null;

  const snapshot = useMemo(
    () =>
      computeNurseCapacity({
        occupancies: board.data?.occupancies ?? [],
        day_available: dayAvail,
        night_available: nightAvail,
      }),
    [board.data, dayAvail, nightAvail],
  );

  const block = shift === "day" ? snapshot.day : snapshot.night;
  const shiftLabel = shift === "day" ? "Day shift (08–20)" : "Night shift (20–08)";
  const loading = board.isLoading || staffing.isLoading;

  return (
    <div className="rounded-md border bg-muted/30 p-3 text-sm" aria-label="Current admission capacity">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-muted-foreground" aria-hidden="true" />
          <span className="font-medium">Admission capacity — {shiftLabel}</span>
        </div>
        <Link
          to="/bed-board"
          className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
        >
          Bed board
        </Link>
      </div>

      {loading ? (
        <div className="text-xs text-muted-foreground">Loading capacity…</div>
      ) : block.available == null ? (
        <div className="text-xs text-muted-foreground">
          No nurse count recorded for this shift yet.{" "}
          <Link to="/bed-board" className="underline underline-offset-2">
            Record on the bed board
          </Link>
          .
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <div>
              <span className="tabular-nums font-semibold">{block.available}</span>
              <span className="text-xs text-muted-foreground ml-1">nurses</span>
            </div>
            <div>
              <span className="tabular-nums font-semibold">{snapshot.dependency.toFixed(2)}</span>
              <span className="text-xs text-muted-foreground ml-1">
                dependency ({snapshot.patient_count} patient{snapshot.patient_count === 1 ? "" : "s"})
              </span>
            </div>
            <div>
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
              <span className="text-xs text-muted-foreground ml-1">spare</span>
            </div>
          </div>

          {(block.spare ?? 0) > 0 ? (
            <div className="mt-1.5 text-xs text-muted-foreground">
              Room for{" "}
              <span className="font-medium text-foreground">{block.level3_slots}</span> L3
              {" · "}
              <span className="font-medium text-foreground">{block.level2_slots}</span> L2
              {" · "}
              <span className="font-medium text-foreground">{block.level1_slots}</span> L1/L0
            </div>
          ) : (
            <div className="mt-1.5 text-xs text-destructive">
              Unit at or over safe nursing capacity — accepting will require additional nursing.
            </div>
          )}
        </>
      )}
    </div>
  );
}
