import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ANTICIPATED_INTERVENTIONS,
  CEILING_OF_CARE_OPTIONS,
  INFECTION_STATUS_OPTIONS,
  REASON_CATEGORY_OPTIONS,
  RESUS_STATUS_OPTIONS,
  shouldShowFrailty,
  type AnticipatedIntervention,
  type CeilingOfCare,
  type InfectionStatus,
  type ReasonCategory,
  type ResusStatus,
} from "@/lib/referral-clinical";

export type WardReviewTimeframe = "12h" | "24h" | "48h" | "72h" | "weekly" | "prn";

export const WARD_REVIEW_TIMEFRAME_OPTIONS: { value: WardReviewTimeframe; label: string }[] = [
  { value: "12h", label: "Within 12 hours" },
  { value: "24h", label: "Within 24 hours" },
  { value: "48h", label: "Within 48 hours" },
  { value: "72h", label: "Within 72 hours" },
  { value: "weekly", label: "Weekly" },
  { value: "prn", label: "As needed (PRN)" },
];

export interface ClinicalFieldsValue {
  news2_score: number | null;
  ceiling_of_care: CeilingOfCare | null;
  reason_category: ReasonCategory | null;
  frailty_score: number | null;
  anticipated_interventions: AnticipatedIntervention[];
  infection_status: InfectionStatus | null;
  infection_organism: string | null;
  weight_kg: number | null;
  allergies: string | null;
  resus_status: ResusStatus | null;
  needs_ward_review: boolean;
  for_ongoing_ccot_review: boolean;
  ward_review_timeframe: WardReviewTimeframe | null;
}

const NONE = "__none";

export function ClinicalFields({
  value,
  onChange,
  age,
  errors,
}: {
  value: ClinicalFieldsValue;
  onChange: (patch: Partial<ClinicalFieldsValue>) => void;
  age: number | null | undefined;
  errors?: Partial<Record<keyof ClinicalFieldsValue, string>>;
}) {
  const showFrailty = shouldShowFrailty(age);
  const set = <K extends keyof ClinicalFieldsValue>(k: K, v: ClinicalFieldsValue[K]) =>
    onChange({ [k]: v } as Partial<ClinicalFieldsValue>);

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="news2">NEWS2 score</Label>
          <Input
            id="news2"
            type="number"
            min={0}
            max={20}
            value={value.news2_score ?? ""}
            onChange={(e) => set("news2_score", e.target.value === "" ? null : Number(e.target.value))}
          />
          {errors?.news2_score && <p className="text-xs text-destructive">{errors.news2_score}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="weight">Weight (kg)</Label>
          <Input
            id="weight"
            type="number"
            min={0}
            step={0.1}
            value={value.weight_kg ?? ""}
            onChange={(e) => set("weight_kg", e.target.value === "" ? null : Number(e.target.value))}
          />
        </div>
        {showFrailty && (
          <div className="space-y-1.5">
            <Label htmlFor="frailty">Rockwell CFS (1–9)</Label>
            <Input
              id="frailty"
              type="number"
              min={1}
              max={9}
              value={value.frailty_score ?? ""}
              onChange={(e) => set("frailty_score", e.target.value === "" ? null : Number(e.target.value))}
            />
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Ceiling of care</Label>
          <Select
            value={value.ceiling_of_care ?? NONE}
            onValueChange={(v) => set("ceiling_of_care", v === NONE ? null : (v as CeilingOfCare))}
          >
            <SelectTrigger className={errors?.ceiling_of_care ? "border-destructive" : undefined}>
              <SelectValue placeholder="Select…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>—</SelectItem>
              {CEILING_OF_CARE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {errors?.ceiling_of_care && <p className="text-xs text-destructive">{errors.ceiling_of_care}</p>}
        </div>
        <div className="space-y-1.5">
          <Label>Resuscitation status</Label>
          <Select
            value={value.resus_status ?? NONE}
            onValueChange={(v) => set("resus_status", v === NONE ? null : (v as ResusStatus))}
          >
            <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>—</SelectItem>
              {RESUS_STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Reason category</Label>
          <Select
            value={value.reason_category ?? NONE}
            onValueChange={(v) => set("reason_category", v === NONE ? null : (v as ReasonCategory))}
          >
            <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>—</SelectItem>
              {REASON_CATEGORY_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Infection status</Label>
          <Select
            value={value.infection_status ?? NONE}
            onValueChange={(v) => set("infection_status", v === NONE ? null : (v as InfectionStatus))}
          >
            <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>—</SelectItem>
              {INFECTION_STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {(value.infection_status === "suspected" || value.infection_status === "confirmed") && (
        <div className="space-y-1.5">
          <Label htmlFor="organism">Organism / source</Label>
          <Input
            id="organism"
            value={value.infection_organism ?? ""}
            onChange={(e) => set("infection_organism", e.target.value || null)}
            maxLength={200}
            placeholder="e.g. E. coli, HAP, unknown source"
          />
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="allergies">Allergies</Label>
        <Textarea
          id="allergies"
          rows={2}
          value={value.allergies ?? ""}
          onChange={(e) => set("allergies", e.target.value || null)}
          maxLength={1000}
          placeholder="Known drug allergies (or 'NKDA')"
        />
      </div>

      <fieldset className="rounded-md border p-3">
        <legend className="text-xs font-medium px-1">Anticipated interventions</legend>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
          {ANTICIPATED_INTERVENTIONS.map((o) => {
            const checked = value.anticipated_interventions.includes(o.value);
            return (
              <label key={o.value} className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={checked}
                  onCheckedChange={(c) => {
                    const next = c
                      ? Array.from(new Set([...value.anticipated_interventions, o.value]))
                      : value.anticipated_interventions.filter((v) => v !== o.value);
                    set("anticipated_interventions", next as AnticipatedIntervention[]);
                  }}
                />
                {o.label}
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="rounded-md border p-3 space-y-3">
        <legend className="text-xs font-medium px-1">Ongoing review</legend>
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <Checkbox
            checked={value.needs_ward_review}
            onCheckedChange={(c) => {
              const next = c === true;
              set("needs_ward_review", next);
              // Clear the timeframe when both review flags are off — the
              // DB check constraint requires at least one to be true.
              if (!next && !value.for_ongoing_ccot_review && value.ward_review_timeframe) {
                set("ward_review_timeframe", null);
              }
            }}
          />
          <span>
            <span className="font-medium">Needs ongoing ward review</span>
            <span className="block text-xs text-muted-foreground">
              Ward team should re-review at the suggested interval.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <Checkbox
            checked={value.for_ongoing_ccot_review}
            onCheckedChange={(c) => {
              const next = c === true;
              set("for_ongoing_ccot_review", next);
              if (!next && !value.needs_ward_review && value.ward_review_timeframe) {
                set("ward_review_timeframe", null);
              }
            }}
          />
          <span>
            <span className="font-medium">For ongoing CCOT review</span>
            <span className="block text-xs text-muted-foreground">
              Keep on the Critical Care Outreach Team review list.
            </span>
          </span>
        </label>
        {(value.needs_ward_review || value.for_ongoing_ccot_review) && (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">
              Turning off both review options will automatically clear the suggested timeframe.
            </p>
            <Label>Suggested review timeframe</Label>
            <Select
              value={value.ward_review_timeframe ?? NONE}
              onValueChange={(v) =>
                set("ward_review_timeframe", v === NONE ? null : (v as WardReviewTimeframe))
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>—</SelectItem>
                {WARD_REVIEW_TIMEFRAME_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </fieldset>
    </div>
  );
}

export function emptyClinicalFields(): ClinicalFieldsValue {
  return {
    news2_score: null,
    ceiling_of_care: null,
    reason_category: null,
    frailty_score: null,
    anticipated_interventions: [],
    infection_status: null,
    infection_organism: null,
    weight_kg: null,
    allergies: null,
    resus_status: null,
    needs_ward_review: false,
    for_ongoing_ccot_review: false,
    ward_review_timeframe: null,
  };
}

export function clinicalFieldsFromRow(row: any): ClinicalFieldsValue {
  const timeframe = row?.ward_review_timeframe;
  const validTimeframes: WardReviewTimeframe[] = ["12h", "24h", "48h", "72h", "weekly", "prn"];
  return {
    news2_score: row?.news2_score ?? null,
    ceiling_of_care: (row?.ceiling_of_care as CeilingOfCare | null) ?? null,
    reason_category: (row?.reason_category as ReasonCategory | null) ?? null,
    frailty_score: row?.frailty_score ?? null,
    anticipated_interventions: Array.isArray(row?.anticipated_interventions)
      ? (row.anticipated_interventions as AnticipatedIntervention[])
      : [],
    infection_status: (row?.infection_status as InfectionStatus | null) ?? null,
    infection_organism: row?.infection_organism ?? null,
    weight_kg: row?.weight_kg == null ? null : Number(row.weight_kg),
    allergies: row?.allergies ?? null,
    resus_status: (row?.resus_status as ResusStatus | null) ?? null,
    needs_ward_review: row?.needs_ward_review === true,
    for_ongoing_ccot_review: row?.for_ongoing_ccot_review === true,
    ward_review_timeframe: validTimeframes.includes(timeframe) ? timeframe : null,
  };
}

