import { format, startOfDay, eachDayOfInterval } from "date-fns";

export const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export const LEVEL_LABELS: Record<string, string> = {
  level_1: "Level 1",
  level_2: "Level 2",
  level_3: "Level 3",
};

export interface PostopBookingRow {
  id: string;
  created_at: string;
  age: number | null;
  sex: string | null;
  bmi: number | string | null;
  predicted_level: string | null;
  arrived_at?: string | null;
}

/** Format a duration in hours as either "Xh" or "Xd" (>= 24h). */
export function fmtH(h: number): string {
  return h >= 24 ? `${(h / 24).toFixed(1)}d` : `${h.toFixed(1)}h`;
}

/** Delta between booking creation and arrival, in hours, or null. */
export function arrivalHoursOf(b: PostopBookingRow): number | null {
  if (!b.arrived_at) return null;
  const s = new Date(b.created_at).getTime();
  const e = new Date(b.arrived_at).getTime();
  if (!isFinite(s) || !isFinite(e) || e < s) return null;
  return (e - s) / 3_600_000;
}

export function dayKeyOf(b: PostopBookingRow): string {
  return format(startOfDay(new Date(b.created_at)), "yyyy-MM-dd");
}

export function makeDayKeys(from: Date, to: Date): string[] {
  return eachDayOfInterval({ start: from, end: to }).map((d) => format(d, "yyyy-MM-dd"));
}

export function buildPerDay(
  bookings: PostopBookingRow[],
  dayKeys: string[],
): Array<{ key: string; date: string; count: number }> {
  const map = new Map<string, number>(dayKeys.map((k) => [k, 0]));
  bookings.forEach((b) => {
    const k = dayKeyOf(b);
    if (map.has(k)) map.set(k, (map.get(k) ?? 0) + 1);
  });
  return Array.from(map.entries()).map(([key, count]) => ({
    key,
    date: format(new Date(key), "dd/MM/yyyy"),
    count,
  }));
}

export function buildPerDayByLevel(
  bookings: PostopBookingRow[],
  dayKeys: string[],
): Array<Record<string, number | string>> {
  const levels = Object.keys(LEVEL_LABELS);
  const map = new Map<string, Record<string, number | string>>(
    dayKeys.map((k) => [
      k,
      {
        key: k,
        date: format(new Date(k), "dd/MM/yyyy"),
        ...Object.fromEntries(levels.map((l) => [LEVEL_LABELS[l], 0])),
      },
    ]),
  );
  bookings.forEach((b) => {
    const k = dayKeyOf(b);
    const row = map.get(k);
    const label = b.predicted_level ? LEVEL_LABELS[b.predicted_level] : undefined;
    if (row && label) row[label] = ((row[label] as number) ?? 0) + 1;
  });
  return Array.from(map.values());
}

export function buildByLevel(
  bookings: PostopBookingRow[],
): Array<{ name: string; value: number }> {
  const map = new Map<string, number>();
  bookings.forEach((b) => {
    const key = (b.predicted_level && LEVEL_LABELS[b.predicted_level]) ?? "Unknown";
    map.set(key, (map.get(key) ?? 0) + 1);
  });
  return Array.from(map.entries()).map(([name, value]) => ({ name, value }));
}

export function buildBySex(
  bookings: PostopBookingRow[],
): Array<{ name: string; value: number }> {
  const map = new Map<string, number>();
  bookings.forEach((b) => {
    const k = b.sex ?? "unknown";
    map.set(k, (map.get(k) ?? 0) + 1);
  });
  return Array.from(map.entries()).map(([name, value]) => ({ name, value }));
}

export function collectArrivalDelays(bookings: PostopBookingRow[]): number[] {
  return bookings
    .map((b) => arrivalHoursOf(b))
    .filter((v): v is number => v != null);
}

export interface ArrivalStats {
  count: number;
  mean: number;
  median: number;
  p90: number;
  min: number;
  max: number;
}

export function summariseArrivalDelays(delays: number[]): ArrivalStats {
  const xs = [...delays].sort((a, b) => a - b);
  if (!xs.length) return { count: 0, mean: 0, median: 0, p90: 0, min: 0, max: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const q = (p: number) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
  return {
    count: xs.length,
    mean,
    median: q(0.5),
    p90: q(0.9),
    min: xs[0],
    max: xs[xs.length - 1],
  };
}

export const ARRIVAL_BUCKET_DEFS: Array<{ name: string; min: number; max: number }> = [
  { name: "<1h", min: 0, max: 1 },
  { name: "1–3h", min: 1, max: 3 },
  { name: "3–6h", min: 3, max: 6 },
  { name: "6–12h", min: 6, max: 12 },
  { name: "12–24h", min: 12, max: 24 },
  { name: "1–2d", min: 24, max: 48 },
  { name: ">2d", min: 48, max: Infinity },
];

export function buildArrivalBuckets(delays: number[]) {
  return ARRIVAL_BUCKET_DEFS.map((b) => ({
    ...b,
    count: delays.filter((h) => h >= b.min && h < b.max).length,
  }));
}

export function meanOf(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
