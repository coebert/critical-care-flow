import { format, startOfDay } from "date-fns";
import {
  urgencyLabel,
  URGENCY_DISPLAY_ORDER,
  type AdmissionUrgency,
} from "./admission-urgency";

export type UrgencyRow = {
  admission_urgency: AdmissionUrgency | null;
  referral_received_at: string;
};

/** Bar chart + counts list source. Only includes labels that have data, in display order. */
export function aggregateUrgencyCounts(
  rows: ReadonlyArray<Pick<UrgencyRow, "admission_urgency">>
): { urgency: string; count: number }[] {
  const map = new Map<string, number>();
  rows.forEach((r) => {
    const k = urgencyLabel(r.admission_urgency);
    map.set(k, (map.get(k) ?? 0) + 1);
  });
  return URGENCY_DISPLAY_ORDER.filter((label) => map.has(label)).map((label) => ({
    urgency: label,
    count: map.get(label)!,
  }));
}

/** Stacked-area chart source. Every bucket carries every legend key (zero-filled). */
export function aggregateUrgencyPerDay(
  rows: ReadonlyArray<UrgencyRow>,
  dayKeys: ReadonlyArray<string>
): Array<{ date: string } & Record<string, number | string>> {
  const buckets = new Map<string, Record<string, number>>(
    dayKeys.map((k) => {
      const row: Record<string, number> = {};
      URGENCY_DISPLAY_ORDER.forEach((u) => (row[u] = 0));
      return [k, row];
    })
  );
  rows.forEach((r) => {
    const k = format(startOfDay(new Date(r.referral_received_at)), "yyyy-MM-dd");
    const row = buckets.get(k);
    if (row) {
      const label = urgencyLabel(r.admission_urgency);
      row[label] = (row[label] ?? 0) + 1;
    }
  });
  return Array.from(buckets.entries()).map(([date, vals]) => ({
    date: format(new Date(date), "dd MMM"),
    ...vals,
  }));
}

/** Legend keys for the stacked area chart — single source of truth. */
export const URGENCY_LEGEND_KEYS = URGENCY_DISPLAY_ORDER;
