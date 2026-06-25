export type AdmissionUrgency =
  | "within_15_min"
  | "within_30_min"
  | "within_1_hour"
  | "within_1_2_hours";

export const ADMISSION_URGENCY_OPTIONS: { value: AdmissionUrgency; label: string }[] = [
  { value: "within_15_min", label: "Within 15 minutes" },
  { value: "within_30_min", label: "Within 30 minutes" },
  { value: "within_1_hour", label: "Within 1 hour" },
  { value: "within_1_2_hours", label: "Within 1–2 hours" },
];

export const ADMISSION_URGENCY_LABELS: Record<AdmissionUrgency, string> =
  Object.fromEntries(ADMISSION_URGENCY_OPTIONS.map((o) => [o.value, o.label])) as Record<
    AdmissionUrgency,
    string
  >;

// Tailwind classes for urgency badge — higher urgency = stronger color.
export const ADMISSION_URGENCY_BADGE: Record<AdmissionUrgency, string> = {
  within_15_min: "bg-red-100 text-red-800 border-red-300 dark:bg-red-950 dark:text-red-200",
  within_30_min: "bg-orange-100 text-orange-800 border-orange-300 dark:bg-orange-950 dark:text-orange-200",
  within_1_hour: "bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-950 dark:text-amber-200",
  within_1_2_hours: "bg-yellow-100 text-yellow-900 border-yellow-300 dark:bg-yellow-950 dark:text-yellow-200",
};
