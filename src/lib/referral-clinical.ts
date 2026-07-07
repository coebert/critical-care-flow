// Referral clinical enums, labels, and small pure helpers.
// No I/O — safe to import in server fns and browser code.

export const CEILING_OF_CARE_OPTIONS = [
  { value: "full_escalation", label: "Full escalation" },
  { value: "no_cpr", label: "Full escalation, not for CPR" },
  { value: "ward_based", label: "Ward-based care only" },
  { value: "symptom_control", label: "Symptom control / palliative" },
  { value: "not_documented", label: "Not documented" },
] as const;
export type CeilingOfCare = (typeof CEILING_OF_CARE_OPTIONS)[number]["value"];

export const REASON_CATEGORY_OPTIONS = [
  { value: "respiratory_failure", label: "Respiratory failure" },
  { value: "sepsis", label: "Sepsis" },
  { value: "shock", label: "Shock / haemodynamic" },
  { value: "post_op", label: "Post-operative" },
  { value: "neurology", label: "Neurological" },
  { value: "trauma", label: "Trauma" },
  { value: "gi_bleed", label: "GI bleed" },
  { value: "metabolic", label: "Metabolic / endocrine" },
  { value: "overdose", label: "Overdose / poisoning" },
  { value: "other", label: "Other" },
] as const;
export type ReasonCategory = (typeof REASON_CATEGORY_OPTIONS)[number]["value"];

export const INFECTION_STATUS_OPTIONS = [
  { value: "none", label: "No known infection" },
  { value: "suspected", label: "Suspected infection" },
  { value: "confirmed", label: "Confirmed infection" },
  { value: "unknown", label: "Unknown" },
] as const;
export type InfectionStatus = (typeof INFECTION_STATUS_OPTIONS)[number]["value"];

export const RESUS_STATUS_OPTIONS = [
  { value: "for_cpr", label: "For CPR" },
  { value: "dnacpr", label: "DNACPR in place" },
  { value: "not_documented", label: "Not documented" },
] as const;
export type ResusStatus = (typeof RESUS_STATUS_OPTIONS)[number]["value"];

export const ANTICIPATED_INTERVENTIONS = [
  { value: "invasive_ventilation", label: "Invasive ventilation" },
  { value: "niv_cpap", label: "NIV / CPAP" },
  { value: "hfno", label: "HFNO" },
  { value: "vasopressors", label: "Vasopressors" },
  { value: "rrt", label: "Renal replacement" },
  { value: "neuro_obs", label: "Neuro observations" },
  { value: "arterial_line", label: "Arterial line" },
  { value: "central_line", label: "Central line" },
  { value: "other", label: "Other" },
] as const;
export type AnticipatedIntervention = (typeof ANTICIPATED_INTERVENTIONS)[number]["value"];
export const ANTICIPATED_INTERVENTION_VALUES = ANTICIPATED_INTERVENTIONS.map((o) => o.value) as readonly AnticipatedIntervention[];

export function getAnticipatedInterventionLabel(v: string): string {
  return ANTICIPATED_INTERVENTIONS.find((o) => o.value === v)?.label ?? v;
}

// ---- NEWS2 tone ----
// NEWS2 thresholds (Royal College of Physicians): 0 low, 1–4 low-med,
// 5–6 med, ≥7 high.
export type News2Tone = "none" | "green" | "amber" | "red";
export function computeNews2Tone(score: number | null | undefined): News2Tone {
  if (score == null) return "none";
  if (score <= 0) return "green";
  if (score <= 4) return "green";
  if (score <= 6) return "amber";
  return "red";
}
export function news2ToneClasses(tone: News2Tone): string {
  switch (tone) {
    case "red":
      return "bg-destructive/10 text-destructive border-destructive/30";
    case "amber":
      return "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30";
    case "green":
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

// ---- Frailty gate ----
export function shouldShowFrailty(age: number | null | undefined): boolean {
  return typeof age === "number" && age >= 65;
}

// ---- Label lookups ----
export function ceilingLabel(v: CeilingOfCare | null | undefined): string | null {
  if (!v) return null;
  return CEILING_OF_CARE_OPTIONS.find((o) => o.value === v)?.label ?? v;
}
export function reasonCategoryLabel(v: ReasonCategory | null | undefined): string | null {
  if (!v) return null;
  return REASON_CATEGORY_OPTIONS.find((o) => o.value === v)?.label ?? v;
}
export function infectionStatusLabel(v: InfectionStatus | null | undefined): string | null {
  if (!v) return null;
  return INFECTION_STATUS_OPTIONS.find((o) => o.value === v)?.label ?? v;
}
export function resusStatusLabel(v: ResusStatus | null | undefined): string | null {
  if (!v) return null;
  return RESUS_STATUS_OPTIONS.find((o) => o.value === v)?.label ?? v;
}
