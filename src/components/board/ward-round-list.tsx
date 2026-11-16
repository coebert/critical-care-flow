import type { UnitCapacityView } from "@/hooks/use-unit-capacity";
import type { AcuityEntry } from "@/lib/patient-acuity-core";
import { failureText } from "@/components/capacity/capacity-status";
import { formatUnitTime } from "@/lib/shift-clock";
import type { PartnerBedSlot } from "@/lib/partner-bed-board-contract";

function dayOfStay(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(1, Math.floor((now - t) / 86_400_000) + 1);
}

export type WardRoundView = Pick<UnitCapacityView, "board" | "freshness" | "latestFailure" | "lastSuccessAt" | "now">;

/** True only when the list may be printed as a current list. */
export function wardRoundIsCurrent(view: WardRoundView): boolean {
  return !!view.board && view.freshness === "current" && !view.latestFailure;
}

/**
 * Ward round list from the scoped ICU Handover Hub snapshot + CCC levels.
 * Shared details only (bed, initials, hospital number, age, day of stay,
 * level / 1:1, TEP / DNACPR flags). Never renders an empty or "current"
 * list when the input failed.
 */
export function WardRoundList({
  capacity,
  acuity,
}: {
  capacity: WardRoundView;
  acuity: { status: string; data: AcuityEntry[] | undefined };
}) {
  const board = capacity.board;
  const nowMs = capacity.now.getTime();
  const current = wardRoundIsCurrent(capacity);
  const acuityFailed = acuity.status === "error";
  const acuityById = new Map((acuity.data ?? []).map((a) => [a.partner_patient_id, a] as const));
  const slots: PartnerBedSlot[] = board
    ? [...board.bed_board]
        .filter((b) => b.occupied)
        .sort((a, b) => a.bed.localeCompare(b.bed, undefined, { numeric: true }))
    : [];
  return (
    <>
      {!board ? (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm">
          {capacity.latestFailure
            ? `${failureText(capacity)} — the ward round list cannot be produced. Nothing to print.`
            : "Loading bed snapshot from ICU Handover Hub…"}
        </div>
      ) : (
        <>
          <div
            className={`mb-2 text-xs ${current ? "text-muted-foreground" : "rounded border border-destructive p-2 font-semibold text-destructive"}`}
            role={current ? undefined : "alert"}
          >
            {current
              ? `Hub snapshot ${formatUnitTime(capacity.lastSuccessAt, capacity.now)} · printed ${formatUnitTime(new Date(nowMs).toISOString(), capacity.now)} · ${slots.length} occupied beds`
              : `NOT CURRENT — Hub snapshot from ${capacity.lastSuccessAt ? formatUnitTime(capacity.lastSuccessAt, capacity.now) : "unknown time"}. Beds may have changed since.`}
            {acuityFailed ? " · Levels of care could not be loaded (shown as ?)." : ""}
          </div>

          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="bg-muted/40 text-left">
                <th className="border p-1 w-14">Bed</th>
                <th className="border p-1 w-32">Patient</th>
                <th className="border p-1 w-20">Level / day</th>
                <th className="border p-1 w-28">Flags</th>
                <th className="border p-1">Jobs &amp; plan</th>
              </tr>
            </thead>
            <tbody>
              {slots.map((s) => {
                const o = s.occupant;
                if (!o) {
                  return (
                    <tr key={s.bed} className="align-top">
                      <td className="border p-1 font-semibold">{s.bed}</td>
                      <td className="border p-1 italic" colSpan={3}>Occupied — details withheld by ICU Handover Hub</td>
                      <td className="border p-1 h-16"></td>
                    </tr>
                  );
                }
                const a = acuityById.get(o.id);
                const lvl = acuityFailed ? "?" : a?.level != null ? `L${a.level}` : "L?";
                const day = dayOfStay(o.admission_date, nowMs);
                const flags = [
                  a?.one_to_one && !acuityFailed ? "1:1" : null,
                  o.tep_in_place ? "TEP" : null,
                  o.dnacpr_decision ? "DNACPR" : null,
                  s.is_side_room ? "SR" : null,
                ].filter(Boolean).join(" · ");
                return (
                  <tr key={s.bed} className="align-top">
                    <td className="border p-1 font-semibold">{s.bed}</td>
                    <td className="border p-1">
                      <div className="font-medium">{o.full_name || "—"}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {o.hospital_number ?? ""}
                        {o.age != null ? ` · ${o.age}y` : ""}
                      </div>
                    </td>
                    <td className="border p-1">{lvl}{day != null ? ` · d${day}` : ""}</td>
                    <td className="border p-1">{flags || "—"}</td>
                    <td className="border p-1 h-16"></td>
                  </tr>
                );
              })}
              {slots.length === 0 && (
                <tr><td colSpan={5} className="border p-4 text-center text-muted-foreground">No occupied beds in this Hub snapshot.</td></tr>
              )}
            </tbody>
          </table>
          {board.stats.unassigned > 0 && (
            <div className="mt-2 text-xs">
              Awaiting a bed: {board.stats.unassigned}
              {board.hidden_unassigned > 0 ? ` (${board.hidden_unassigned} not disclosed by the Hub)` : ""}
            </div>
          )}
        </>
      )}
    </>
  );
}
