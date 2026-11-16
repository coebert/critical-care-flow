import { Link } from "@tanstack/react-router";
import { AlertTriangle, Users } from "lucide-react";

import { useUnitCapacity } from "@/hooks/use-unit-capacity";
import { formatShiftDate, shiftHoursLabel, shiftName } from "@/lib/shift-clock";
import { CapacityFreshness } from "@/components/capacity/capacity-status";

/**
 * Read-only capacity callout on the referral outcome card. Same data and
 * calculation as the Bed Board (useUnitCapacity): beds and nursing room are
 * separate, and anything unknown or delayed is said in words.
 */
export function AdmissionCapacityCallout() {
  const view = useUnitCapacity();
  const { shift, derivation, reassuring, freshness } = view;
  const { physical, nursing } = derivation;
  const heading = `${shiftName(shift.shift)} ${shiftHoursLabel(shift.shift)} · ${formatShiftDate(shift.date)}`;

  return (
    <section
      className="rounded-md border bg-muted/30 p-3 text-sm"
      aria-label="Current admission capacity"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <Users className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />
          <span className="font-medium">Admission capacity — {heading}</span>
        </div>
        <Link
          to="/bed-board"
          search={{ focus_shift: shift.shift }}
          className="text-xs min-h-8 inline-flex items-center text-muted-foreground hover:text-foreground underline underline-offset-2"
        >
          Open bed board
        </Link>
      </div>

      <div className="mb-2 text-xs">
        <CapacityFreshness view={view} />
      </div>

      {freshness === "stale" && (
        <p className="mb-2 text-xs text-amber-900 dark:text-amber-200">
          Figures below are the last known values and may be out of date.
        </p>
      )}

      {physical ? (
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1">
          <div>
            <dt className="text-xs text-muted-foreground">Beds free</dt>
            <dd className="tabular-nums font-semibold">
              {physical.vacant} <span className="font-normal text-muted-foreground">of {physical.total}</span>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Awaiting a bed</dt>
            <dd className="tabular-nums font-semibold">{physical.unassigned}</dd>
          </div>
          {nursing.state === "ok" || nursing.state === "no_staffing" ? (
            <div>
              <dt className="text-xs text-muted-foreground">Nurses needed</dt>
              <dd className="tabular-nums font-semibold">
                {nursing.dependency.toFixed(2)}{" "}
                <span className="font-normal text-muted-foreground text-xs">
                  for {nursing.patient_count} patient{nursing.patient_count === 1 ? "" : "s"}
                </span>
              </dd>
            </div>
          ) : null}
          {nursing.state === "ok" ? (
            <div>
              <dt className="text-xs text-muted-foreground">Nurses on shift · spare</dt>
              <dd className="tabular-nums font-semibold">
                {nursing.available} · {nursing.spare.toFixed(2)}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      <div className="mt-2 text-xs">
        {nursing.state === "ok" ? (
          nursing.spare > 0 ? (
            <p className={reassuring ? "" : "text-muted-foreground"}>
              Nursing room for{" "}
              <strong className="tabular-nums">{nursing.level3_slots}</strong> L3 ·{" "}
              <strong className="tabular-nums">{nursing.level2_slots}</strong> L2 ·{" "}
              <strong className="tabular-nums">{nursing.level1_slots}</strong> L1/L0
              {physical && physical.vacant === 0 ? " — but no physical bed is free." : "."}
            </p>
          ) : (
            <p className="text-destructive font-medium">
              No nursing room: the unit is at or over safe nursing capacity (0 L3 · 0 L2 · 0 L1/L0).
            </p>
          )
        ) : nursing.state === "no_staffing" ? (
          <p className="flex items-start gap-1 text-amber-900 dark:text-amber-200">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              No nurse count recorded for this shift, so nursing room is unknown.{" "}
              <Link to="/bed-board" search={{ focus_shift: shift.shift }} className="underline underline-offset-2">
                Record it on the bed board
              </Link>
              .
            </span>
          </p>
        ) : nursing.reason === "loading" ? (
          <p className="text-muted-foreground">Loading capacity…</p>
        ) : (
          <p className="flex items-start gap-1 text-amber-900 dark:text-amber-200">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
            <span>{nursing.message}. Check the bed board before accepting.</span>
          </p>
        )}
      </div>
    </section>
  );
}
