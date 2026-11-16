import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Users, Pencil, Check, X, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { admissionSlots } from "@/lib/nurse-capacity";
import { upsertNurseStaffing } from "@/lib/nurse-staffing.functions";
import {
  STAFFING_QK_ROOT,
  useNurseStaffingRows,
  type UnitCapacityView,
} from "@/hooks/use-unit-capacity";
import { availableNursesFor } from "@/lib/unit-capacity";
import {
  formatShiftDate,
  nextShift,
  shiftHoursLabel,
  type Shift,
  type ShiftKey,
} from "@/lib/shift-clock";

type Block = {
  spare: number | null;
  level3_slots: number | null;
  level2_slots: number | null;
  level1_slots: number | null;
};

function ShiftRow({
  label,
  shiftKey,
  isCurrent,
  available,
  availableLoading,
  availableError,
  block,
  demandUnknown,
  reassuring,
  saving,
  onSave,
  focused,
  focusLevel,
}: {
  label: string;
  shiftKey: ShiftKey;
  isCurrent: boolean;
  available: number | null;
  availableLoading: boolean;
  availableError: boolean;
  block: Block;
  demandUnknown: string | null;
  reassuring: boolean;
  saving: boolean;
  /** Resolves true on success; false keeps the editor (and draft) open. */
  onSave: (k: ShiftKey, value: number) => Promise<boolean>;
  focused?: boolean;
  focusLevel?: 1 | 2 | 3;
}) {
  const shift: Shift = shiftKey.shift;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(available == null ? "" : String(available));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // Open the editor automatically once we KNOW no count is recorded
    // (not while loading / on error).
    if (!availableLoading && !availableError && available == null) setEditing(true);
  }, [available, availableLoading, availableError]);

  useEffect(() => {
    if (!editing) setDraft(available == null ? "" : String(available));
  }, [available, editing]);

  const submit = async () => {
    // Blank is "no count", never 0 — refuse to save it.
    const trimmed = draft.trim();
    if (trimmed === "") {
      setError("Enter the number of nurses (0 is allowed). A blank box is not saved.");
      return;
    }
    const n = Number(trimmed);
    if (!isFinite(n) || n < 0) {
      setError("Enter a number that is 0 or more.");
      return;
    }
    setError(null);
    const ok = await onSave(shiftKey, n);
    if (ok) setEditing(false);
    else setError("Not saved — your number is kept here. Check the connection and try again.");
  };
  const cancel = () => {
    setError(null);
    setDraft(available == null ? "" : String(available));
    setEditing(false);
  };

  const rowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focused && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [focused]);

  const l3Focus = focused && focusLevel === 3;
  const l2Focus = focused && focusLevel === 2;
  const l1Focus = focused && focusLevel === 1;

  return (
    <div
      ref={rowRef}
      className={`rounded-md border p-3 space-y-2 transition-colors ${
        focused ? "border-primary ring-2 ring-primary/40 bg-primary/5" : ""
      }`}
      data-focused={focused ? "true" : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">
          {label} shift <span className="font-normal text-muted-foreground">{shiftHoursLabel(shift)} · {formatShiftDate(shiftKey.date)}</span>
          {isCurrent ? <span className="ml-2 rounded border px-1 text-[10px] uppercase tracking-wide">Now</span> : <span className="ml-2 rounded border border-dashed px-1 text-[10px] uppercase tracking-wide text-muted-foreground">Next</span>}
          {focused ? <span className="ml-2 text-xs font-normal text-primary">· reviewing</span> : null}
        </div>
        {!editing && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 min-w-8 px-2"
            onClick={() => setEditing(true)}
            disabled={availableLoading || availableError}
            aria-label={`Edit ${label} shift nurses for ${formatShiftDate(shiftKey.date)}`}
          >
            <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
          </Button>
        )}
      </div>

      {editing && error && (
        <div id={`nurses-err-${shiftKey.date}-${shift}`} role="alert" className="text-xs text-destructive">
          {error}
        </div>
      )}
      {editing ? (
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Label htmlFor={`nurses-${shiftKey.date}-${shift}`} className="text-xs text-muted-foreground">
              Available nurses ({label.toLowerCase()} {formatShiftDate(shiftKey.date)})
            </Label>
            <Input
              id={`nurses-${shiftKey.date}-${shift}`}
              type="number"
              inputMode="decimal"
              step="0.5"
              min="0"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
                if (e.key === "Escape") cancel();
              }}
              disabled={saving}
              className="h-9"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `nurses-err-${shiftKey.date}-${shift}` : undefined}
            />
          </div>
          <Button size="sm" className="h-9 min-w-9" onClick={submit} disabled={saving} aria-label={`Save ${label.toLowerCase()} shift nurse count`}>
            <Check className="w-3.5 h-3.5" aria-hidden="true" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-9 min-w-9"
            onClick={cancel}
            disabled={saving}
            aria-label={`Cancel editing ${label.toLowerCase()} shift nurse count`}
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </Button>
        </div>
      ) : (
        <>
          {availableLoading ? (
            <div className="text-xs text-muted-foreground">Loading staffing…</div>
          ) : availableError ? (
            <div className="text-xs text-amber-900 dark:text-amber-200 flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
              Staffing could not be loaded — capacity unknown.
            </div>
          ) : (
            <div className="flex items-baseline gap-2">
              <div className="text-2xl font-semibold tabular-nums">{available ?? "—"}</div>
              <div className="text-xs text-muted-foreground">
                {available == null ? "no nurse count recorded" : "nurses available"}
              </div>
            </div>
          )}
          {demandUnknown && available != null && (
            <div className="text-xs text-amber-900 dark:text-amber-200">{demandUnknown}</div>
          )}
          {!demandUnknown && block.spare != null && (
            <div className="text-xs text-muted-foreground">
              Spare capacity:{" "}
              <span
                className={
                  block.spare < 0
                    ? "font-semibold text-destructive"
                    : block.spare === 0
                      ? "font-semibold text-amber-700 dark:text-amber-400"
                      : reassuring
                        ? "font-semibold text-emerald-700 dark:text-emerald-400"
                        : "font-semibold text-foreground"
                }
              >
                {block.spare.toFixed(2)}
              </span>{" "}
              nurses{block.spare < 0 ? " (over capacity)" : ""}
            </div>
          )}
          {!demandUnknown && block.spare != null && block.spare > 0 && (
            <div className="text-xs text-muted-foreground">
              Can admit{" "}
              <span className={`font-medium text-foreground ${l3Focus ? "rounded bg-primary/20 px-1 ring-1 ring-primary" : ""}`}>
                {block.level3_slots}
              </span>{" "}L3
              {" · "}
              <span className={`font-medium text-foreground ${l2Focus ? "rounded bg-primary/20 px-1 ring-1 ring-primary" : ""}`}>
                {block.level2_slots}
              </span>{" "}L2
              {" · "}
              <span className={`font-medium text-foreground ${l1Focus ? "rounded bg-primary/20 px-1 ring-1 ring-primary" : ""}`}>
                {block.level1_slots}
              </span>{" "}L1/L0
              {!reassuring ? " (last known — not current)" : ""}
            </div>
          )}
          {!demandUnknown && block.spare != null && block.spare <= 0 && (
            <div className="text-xs text-destructive font-medium">
              Unit at or over safe nursing capacity — no room for new admissions (0 L3 · 0 L2 · 0 L1/L0).
            </div>
          )}
        </>
      )}
    </div>
  );
}

function blockFor(available: number | null, dependency: number | null): Block {
  if (available == null || dependency == null) {
    return { spare: null, level3_slots: null, level2_slots: null, level1_slots: null };
  }
  const spare = Math.round((available - dependency) * 100) / 100;
  return { spare, ...admissionSlots(spare) };
}

/**
 * Nurse capacity for the shift in progress and the next one, using the
 * shared unit capacity view (same numbers as every other surface).
 */
export function NurseCapacityPanel({
  view,
  focusShift,
  focusLevel,
}: {
  view: UnitCapacityView;
  focusShift?: Shift;
  focusLevel?: 1 | 2 | 3;
}) {
  const qc = useQueryClient();
  const doUpsert = useServerFn(upsertNurseStaffing);
  const current = view.shift;
  const upcoming = nextShift(current);
  const currentRows = useNurseStaffingRows(current.date);
  const nextRows = useNurseStaffingRows(upcoming.date);
  const [saving, setSaving] = useState(false);

  const { nursing } = view.derivation;
  const demand = nursing.state === "ok" || nursing.state === "no_staffing" ? nursing : null;
  const demandUnknown =
    nursing.state === "unknown" && nursing.reason !== "loading" ? nursing.message : null;

  const handleSave = async (k: ShiftKey, value: number): Promise<boolean> => {
    setSaving(true);
    try {
      await doUpsert({ data: { shift_date: k.date, shift: k.shift, available_nurses: value } });
      toast.success(`${k.shift === "day" ? "Day" : "Night"} shift ${formatShiftDate(k.date)} updated`);
      await qc.invalidateQueries({ queryKey: STAFFING_QK_ROOT });
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const rows = [
    { key: current, q: currentRows, isCurrent: true },
    { key: upcoming, q: nextRows, isCurrent: false },
  ];

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <Users className="w-4 h-4 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-sm font-semibold">Nurse capacity — this shift and next</h3>
      </div>

      <div id="nurse-capacity" className="p-3 space-y-3">
        <div className="rounded-md bg-muted/40 px-3 py-2">
          <div className="text-xs text-muted-foreground">Current unit dependency</div>
          {demand ? (
            <>
              <div className="flex items-baseline gap-2">
                <div className="text-2xl font-semibold tabular-nums">{demand.dependency.toFixed(2)}</div>
                <div className="text-xs text-muted-foreground">
                  nurses required for {demand.patient_count} patient{demand.patient_count === 1 ? "" : "s"}
                  {view.derivation.physical && view.derivation.physical.unassigned > 0
                    ? ` (incl. ${view.derivation.physical.unassigned} awaiting a bed)`
                    : ""}
                </div>
              </div>
              {demand.dependency > 0 && (
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
                  <div className="flex h-full">
                    <div
                      className="h-full bg-rose-500"
                      style={{ width: `${(demand.one_to_one_dependency / demand.dependency) * 100}%` }}
                    />
                    <div
                      className="h-full bg-primary"
                      style={{ width: `${(demand.level_weighted_dependency / demand.dependency) * 100}%` }}
                    />
                  </div>
                </div>
              )}
              <div className="mt-2 space-y-0.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-rose-500" aria-hidden="true" />
                    From 1:1 patients ({demand.one_to_one_count})
                  </span>
                  <span className="font-medium tabular-nums">{demand.one_to_one_dependency.toFixed(2)}</span>
                </div>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                    From level-of-care weighting
                  </span>
                  <span className="font-medium tabular-nums">{demand.level_weighted_dependency.toFixed(2)}</span>
                </div>
              </div>
            </>
          ) : (
            <div className="text-sm text-amber-900 dark:text-amber-200 flex items-start gap-1 mt-1">
              {demandUnknown ? (
                <>
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                  <span>{demandUnknown}</span>
                </>
              ) : (
                <span className="text-muted-foreground">Loading…</span>
              )}
            </div>
          )}
          <div className="mt-2 text-[11px] text-muted-foreground leading-snug">
            1:1 = 1 · L3 = 1 · L2 = 0.5 · L1/L0 = 0.25 nurse per patient
          </div>
        </div>

        {rows.map(({ key, q, isCurrent }) => {
          const available = q.data ? availableNursesFor(q.data, key.shift) : null;
          return (
            <ShiftRow
              key={`${key.date}#${key.shift}`}
              label={key.shift === "day" ? "Day" : "Night"}
              shiftKey={key}
              isCurrent={isCurrent}
              available={available}
              availableLoading={q.data === undefined && q.status !== "error"}
              availableError={q.status === "error"}
              block={blockFor(available, demand ? demand.dependency : null)}
              demandUnknown={demandUnknown}
              reassuring={view.reassuring}
              saving={saving}
              onSave={handleSave}
              focused={focusShift === key.shift}
              focusLevel={focusShift === key.shift ? focusLevel : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}
