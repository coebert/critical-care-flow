import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Users, Pencil, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Occupancy } from "@/lib/bed-capacity";
import {
  computeNurseCapacity,
  todayIsoDate,
  type Shift,
} from "@/lib/nurse-capacity";
import {
  getNurseStaffingForDate,
  upsertNurseStaffing,
} from "@/lib/nurse-staffing.functions";

type Row = {
  id: string;
  shift_date: string;
  shift: string;
  available_nurses: number;
  notes: string | null;
  updated_at: string;
};

const QK_NURSE = ["nurse-staffing", "today"] as const;

function ShiftRow({
  label,
  shift,
  available,
  block,
  saving,
  onSave,
  focused,
  focusLevel,
}: {
  label: string;
  shift: Shift;
  available: number | null;
  block: { spare: number | null; level3_slots: number | null; level2_slots: number | null; level1_slots: number | null };
  saving: boolean;
  onSave: (shift: Shift, value: number) => Promise<void>;
  focused?: boolean;
  focusLevel?: 1 | 2 | 3;
}) {
  const [editing, setEditing] = useState(available == null);
  const [draft, setDraft] = useState<string>(available == null ? "" : String(available));

  useEffect(() => {
    if (!editing) setDraft(available == null ? "" : String(available));
  }, [available, editing]);

  const submit = async () => {
    const n = Number(draft);
    if (!isFinite(n) || n < 0) {
      toast.error("Enter a non-negative number");
      return;
    }
    await onSave(shift, n);
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
          {label} shift{focused ? <span className="ml-2 text-xs font-normal text-primary">· reviewing</span> : null}
        </div>
        {!editing && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={() => setEditing(true)}
            aria-label={`Edit ${label} shift nurses`}
          >
            <Pencil className="w-3.5 h-3.5" />
          </Button>
        )}
      </div>

      {editing ? (
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Label htmlFor={`nurses-${shift}`} className="text-xs text-muted-foreground">
              Available nurses
            </Label>
            <Input
              id={`nurses-${shift}`}
              type="number"
              inputMode="decimal"
              step="0.5"
              min="0"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={saving}
              className="h-8"
            />
          </div>
          <Button size="sm" className="h-8" onClick={submit} disabled={saving}>
            <Check className="w-3.5 h-3.5" />
          </Button>
          {available != null && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8"
              onClick={() => setEditing(false)}
              disabled={saving}
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <div className="text-2xl font-semibold tabular-nums">{available}</div>
            <div className="text-xs text-muted-foreground">nurses available</div>
          </div>
          {block.spare != null && (
            <div className="text-xs text-muted-foreground">
              Spare capacity:{" "}
              <span
                className={
                  block.spare < 0
                    ? "font-semibold text-destructive"
                    : block.spare === 0
                      ? "font-semibold text-amber-600 dark:text-amber-400"
                      : "font-semibold text-emerald-700 dark:text-emerald-400"
                }
              >
                {block.spare.toFixed(2)}
              </span>{" "}
              nurses
            </div>
          )}
          {block.spare != null && block.spare > 0 && (
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
            </div>
          )}
          {block.spare != null && block.spare <= 0 && (
            <div className="text-xs text-destructive">
              Unit at or over safe nursing capacity — no room for new admissions.
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function NurseCapacityPanel({
  occupancies,
  focusShift,
  focusLevel,
  oneToOneCount,
}: {
  occupancies: Occupancy[];
  focusShift?: Shift;
  focusLevel?: 1 | 2 | 3;
  oneToOneCount?: number;
}) {

  const today = todayIsoDate();
  const qc = useQueryClient();
  const fetchStaffing = useServerFn(getNurseStaffingForDate);
  const doUpsert = useServerFn(upsertNurseStaffing);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: [...QK_NURSE, today],
    queryFn: () => fetchStaffing({ data: { shift_date: today } }) as Promise<Row[]>,
    staleTime: 30_000,
  });

  const [saving, setSaving] = useState(false);

  const dayAvail =
    rows.find((r) => r.shift === "day")?.available_nurses ?? null;
  const nightAvail =
    rows.find((r) => r.shift === "night")?.available_nurses ?? null;

  const snapshot = useMemo(
    () =>
      computeNurseCapacity({
        occupancies,
        day_available: dayAvail,
        night_available: nightAvail,
      }),
    [occupancies, dayAvail, nightAvail],
  );

  const handleSave = async (shift: Shift, value: number) => {
    setSaving(true);
    try {
      await doUpsert({
        data: { shift_date: today, shift, available_nurses: value },
      });
      toast.success(`${shift === "day" ? "Day" : "Night"} shift updated`);
      qc.invalidateQueries({ queryKey: QK_NURSE });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <Users className="w-4 h-4 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-sm font-semibold">Nurse capacity — next 24 h</h3>
      </div>

      <div id="nurse-capacity" className="p-3 space-y-3">
        <div className="rounded-md bg-muted/40 px-3 py-2">
          <div className="text-xs text-muted-foreground">Current unit dependency</div>
          <div className="flex items-baseline gap-2">
            <div className="text-2xl font-semibold tabular-nums">
              {snapshot.dependency.toFixed(2)}
            </div>
            <div className="text-xs text-muted-foreground">
              nurses required for {snapshot.patient_count} patient{snapshot.patient_count === 1 ? "" : "s"}
            </div>
          </div>
          {(oneToOneCount ?? snapshot.one_to_one_count) > 0 && (
            <div className="mt-1 text-[11px] text-rose-700 dark:text-rose-400">
              Includes {oneToOneCount ?? snapshot.one_to_one_count} patient
              {(oneToOneCount ?? snapshot.one_to_one_count) === 1 ? "" : "s"} on 1:1 nursing
              (counted as a full nurse each).
            </div>
          )}
          <div className="mt-1 text-[11px] text-muted-foreground leading-snug">
            1:1 = 1 · L3 = 1 · L2 = 0.5 · L1/L0 = 0.25 nurse per patient
          </div>

        </div>

        {isLoading ? (
          <div className="text-xs text-muted-foreground">Loading staffing…</div>
        ) : (
          <>
            <ShiftRow
              label="Day"
              shift="day"
              available={dayAvail}
              block={snapshot.day}
              saving={saving}
              onSave={handleSave}
              focused={focusShift === "day"}
              focusLevel={focusShift === "day" ? focusLevel : undefined}
            />
            <ShiftRow
              label="Night"
              shift="night"
              available={nightAvail}
              block={snapshot.night}
              saving={saving}
              onSave={handleSave}
              focused={focusShift === "night"}
              focusLevel={focusShift === "night" ? focusLevel : undefined}
            />
          </>
        )}
      </div>
    </div>
  );
}
