import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertAdmin } from "./auth-guards";
import { safeError } from "./safe-error";

/**
 * Wardable-to-discharge analytics for the /analytics "Wardable" tab.
 *
 * Source of truth: `patient_wardable_status`. Every completed episode
 * (both `wardable_at` and `discharged_at` set) becomes one data point.
 * Specialty is derived from the most recent `bed_occupancies` row that
 * links to a referral, since neither the wardable table nor patients
 * carry specialty directly.
 *
 * Admin-only; matches every other analytics panel on this route.
 */

export type WardableEpisode = {
  partner_patient_id: string;
  wardable_at: string;
  discharged_at: string;
  hours: number;
  specialty: string | null;
};

export type WardableDailyPoint = {
  date: string; // yyyy-mm-dd of discharged_at
  count: number;
  medianHours: number;
  meanHours: number;
};

export type WardableSpecialtyPoint = {
  specialty: string;
  count: number;
  medianHours: number;
  meanHours: number;
  p90Hours: number;
};

export type WardableBucketPoint = {
  bucket: string;
  min: number;
  max: number | null;
  count: number;
};

export type WardableAnalytics = {
  totalCompleted: number;
  openCount: number;
  medianHours: number | null;
  meanHours: number | null;
  p90Hours: number | null;
  daily: WardableDailyPoint[];
  bySpecialty: WardableSpecialtyPoint[];
  distribution: WardableBucketPoint[];
};

const rangeSchema = z
  .object({ from: z.string(), to: z.string() })
  .refine((r) => r.from <= r.to, { message: "from must be <= to" });

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next !== undefined ? sorted[base] + rest * (next - sorted[base]) : sorted[base];
}

const BUCKETS: Array<{ bucket: string; min: number; max: number | null }> = [
  { bucket: "0–2h", min: 0, max: 2 },
  { bucket: "2–6h", min: 2, max: 6 },
  { bucket: "6–12h", min: 6, max: 12 },
  { bucket: "12–24h", min: 12, max: 24 },
  { bucket: "1–2d", min: 24, max: 48 },
  { bucket: "2–3d", min: 48, max: 72 },
  { bucket: "3d+", min: 72, max: null },
];

export const getWardableAnalytics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => rangeSchema.parse(d))
  .handler(async ({ data, context }): Promise<WardableAnalytics> => {
    await assertAdmin(context);
    try {
      const fromIso = `${data.from}T00:00:00.000Z`;
      const toIso = `${data.to}T23:59:59.999Z`;

      // Completed episodes discharged inside the window.
      const { data: rows, error } = await context.supabase
        .from("patient_wardable_status")
        .select("partner_patient_id, wardable_at, discharged_at")
        .not("wardable_at", "is", null)
        .not("discharged_at", "is", null)
        .gte("discharged_at", fromIso)
        .lte("discharged_at", toIso)
        .order("discharged_at", { ascending: true })
        .limit(10000);
      if (error) throw error;

      // Still-open wardable declarations (no discharge yet) — useful counter
      // alongside the completed episodes.
      const { count: openCount, error: openErr } = await context.supabase
        .from("patient_wardable_status")
        .select("partner_patient_id", { count: "exact", head: true })
        .eq("wardable", true)
        .is("discharged_at", null);
      if (openErr) throw openErr;

      const completed = (rows ?? []).filter(
        (r) => r.wardable_at && r.discharged_at,
      );

      // Look up the most recent occupancy per partner patient to get a
      // linking referral id → specialty. Batch by IN () to keep it cheap.
      const specialtyByPatient = new Map<string, string | null>();
      const ids = Array.from(
        new Set(completed.map((r) => r.partner_patient_id as string)),
      );
      if (ids.length > 0) {
        const { data: occ, error: occErr } = await context.supabase
          .from("bed_occupancies")
          .select("patient_id, source_referral_id, admitted_at")
          .in("patient_id", ids)
          .not("source_referral_id", "is", null)
          .order("admitted_at", { ascending: false })
          .limit(5000);
        if (occErr) throw occErr;
        const refByPatient = new Map<string, string>();
        for (const row of occ ?? []) {
          const pid = row.patient_id as string | null;
          const rid = row.source_referral_id as string | null;
          if (pid && rid && !refByPatient.has(pid)) refByPatient.set(pid, rid);
        }
        const refIds = Array.from(new Set(refByPatient.values()));
        const specialtyByRef = new Map<string, string | null>();
        if (refIds.length > 0) {
          const { data: refs, error: refErr } = await context.supabase
            .from("referrals")
            .select("id, referring_specialty")
            .in("id", refIds);
          if (refErr) throw refErr;
          for (const r of refs ?? []) {
            specialtyByRef.set(
              r.id as string,
              (r.referring_specialty as string | null) ?? null,
            );
          }
        }
        for (const [pid, rid] of refByPatient) {
          specialtyByPatient.set(pid, specialtyByRef.get(rid) ?? null);
        }
      }

      const episodes: WardableEpisode[] = completed.map((r) => {
        const wa = new Date(r.wardable_at as string).getTime();
        const da = new Date(r.discharged_at as string).getTime();
        const hours = Math.max(0, (da - wa) / 3_600_000);
        return {
          partner_patient_id: r.partner_patient_id as string,
          wardable_at: r.wardable_at as string,
          discharged_at: r.discharged_at as string,
          hours,
          specialty:
            specialtyByPatient.get(r.partner_patient_id as string) ?? null,
        };
      });

      // Overall summary stats.
      const allSorted = [...episodes.map((e) => e.hours)].sort((a, b) => a - b);
      const total = episodes.length;
      const meanHours =
        total === 0 ? null : allSorted.reduce((a, b) => a + b, 0) / total;
      const medianHours = total === 0 ? null : median(allSorted);
      const p90Hours = total === 0 ? null : quantile(allSorted, 0.9);

      // Daily bucketing by discharged_at day (fill zeros across window).
      const perDay = new Map<string, number[]>();
      for (const d of eachDay(data.from, data.to)) perDay.set(d, []);
      for (const e of episodes) {
        const k = dayKey(e.discharged_at);
        const arr = perDay.get(k);
        if (arr) arr.push(e.hours);
      }
      const daily: WardableDailyPoint[] = Array.from(perDay.entries()).map(
        ([date, hoursList]) => {
          const sorted = [...hoursList].sort((a, b) => a - b);
          const c = sorted.length;
          return {
            date,
            count: c,
            medianHours: c === 0 ? 0 : Math.round(median(sorted) * 10) / 10,
            meanHours:
              c === 0
                ? 0
                : Math.round((sorted.reduce((a, b) => a + b, 0) / c) * 10) / 10,
          };
        },
      );

      // By specialty.
      const bySpecMap = new Map<string, number[]>();
      for (const e of episodes) {
        const key = e.specialty ?? "Unknown";
        const arr = bySpecMap.get(key) ?? [];
        arr.push(e.hours);
        bySpecMap.set(key, arr);
      }
      const bySpecialty: WardableSpecialtyPoint[] = Array.from(
        bySpecMap.entries(),
      )
        .map(([specialty, list]) => {
          const sorted = [...list].sort((a, b) => a - b);
          const c = sorted.length;
          return {
            specialty,
            count: c,
            medianHours: Math.round(median(sorted) * 10) / 10,
            meanHours:
              Math.round((sorted.reduce((a, b) => a + b, 0) / c) * 10) / 10,
            p90Hours: Math.round(quantile(sorted, 0.9) * 10) / 10,
          };
        })
        .sort((a, b) => b.count - a.count);

      // Duration histogram.
      const distribution: WardableBucketPoint[] = BUCKETS.map((b) => ({
        ...b,
        count: episodes.filter(
          (e) => e.hours >= b.min && (b.max == null || e.hours < b.max),
        ).length,
      }));

      return {
        totalCompleted: total,
        openCount: openCount ?? 0,
        medianHours: medianHours == null ? null : Math.round(medianHours * 10) / 10,
        meanHours: meanHours == null ? null : Math.round(meanHours * 10) / 10,
        p90Hours: p90Hours == null ? null : Math.round(p90Hours * 10) / 10,
        daily,
        bySpecialty,
        distribution,
      };
    } catch (err) {
      throw safeError(
        "wardable-analytics",
        err,
        "Could not load wardable analytics",
      );
    }
  });
