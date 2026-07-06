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

/**
 * Bar chart + counts list source. Only includes labels that have data,
 * emitted in canonical URGENCY_DISPLAY_ORDER so axis/counts always agree.
 *
 * Rows with missing/unknown urgency values are bucketed under "Not set"
 * via `urgencyLabel`, never dropped — so totals always equal row count.
 */
export function aggregateUrgencyCounts(
  rows: ReadonlyArray<{ admission_urgency?: unknown }>
): { urgency: string; count: number }[] {
  const map = new Map<string, number>();
  rows.forEach((r) => {
    const k = urgencyLabel(r?.admission_urgency);
    map.set(k, (map.get(k) ?? 0) + 1);
  });
  return URGENCY_DISPLAY_ORDER.filter((label) => map.has(label)).map((label) => ({
    urgency: label,
    count: map.get(label)!,
  }));
}

/**
 * Stacked-area chart source. Every bucket carries every legend key
 * (zero-filled) so the legend, axis ticks and stacked totals stay aligned
 * even on days with no referrals.
 *
 * Rows with missing/invalid `referral_received_at` are routed into the
 * first day bucket (or skipped if there are no buckets) rather than
 * being silently lost — keeping stacked totals consistent with the
 * counts aggregator above.
 */
export function aggregateUrgencyPerDay(
  rows: ReadonlyArray<{ admission_urgency?: unknown; referral_received_at?: string | null }>,
  dayKeys: ReadonlyArray<string>
): Array<{ date: string } & Record<string, number | string>> {
  const buckets = new Map<string, Record<string, number>>(
    dayKeys.map((k) => {
      const row: Record<string, number> = {};
      URGENCY_DISPLAY_ORDER.forEach((u) => (row[u] = 0));
      return [k, row];
    })
  );
  const fallbackKey = dayKeys[0];
  rows.forEach((r) => {
    const label = urgencyLabel(r?.admission_urgency);
    let bucketKey: string | undefined;
    const raw = r?.referral_received_at;
    if (raw) {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) {
        const k = format(startOfDay(d), "yyyy-MM-dd");
        if (buckets.has(k)) bucketKey = k;
      }
    }
    if (!bucketKey && fallbackKey && buckets.has(fallbackKey)) {
      bucketKey = fallbackKey;
    }
    if (bucketKey) {
      const row = buckets.get(bucketKey)!;
      row[label] = (row[label] ?? 0) + 1;
    }
  });
  return Array.from(buckets.entries()).map(([date, vals]) => ({
    date: format(new Date(date), "dd/MM/yyyy"),
    ...vals,
  }));
}

/** Legend keys for the stacked area chart — single source of truth. */
export const URGENCY_LEGEND_KEYS = URGENCY_DISPLAY_ORDER;
