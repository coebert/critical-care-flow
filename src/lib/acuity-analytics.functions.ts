import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertAdmin } from "./auth-guards";
import { safeError } from "./safe-error";

/**
 * Daily acuity analytics for the /analytics "Acuity" tab.
 *
 * The `patient_acuity_history` table logs every change to
 * `patient_acuity_overrides` (source='change') plus a nightly snapshot of
 * the current per-patient level (source='snapshot'). We replay those events
 * chronologically to reconstruct per-patient state at the end of each day,
 * and derive:
 *
 *  - `scored`       — number of scoring events on that day (level set/changed)
 *  - `l0..l3`       — count of patients holding each level at end of day
 *  - `patientsScored` — total patients with a non-null level at end of day
 *  - `meanAcuity`   — average of held levels (null if no scored patients)
 *
 * Admin-only, matches every other panel on this route.
 */

export type AcuityDailyPoint = {
  date: string; // yyyy-mm-dd
  scored: number;
  l0: number;
  l1: number;
  l2: number;
  l3: number;
  patientsScored: number;
  meanAcuity: number | null;
};

const rangeSchema = z
  .object({
    from: z.string(),
    to: z.string(),
  })
  .refine((r) => r.from <= r.to, { message: "from must be <= to" });

function dayKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(dayKey(d));
  }
  return out;
}

export const getAcuityAnalytics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => rangeSchema.parse(d))
  .handler(async ({ data, context }): Promise<AcuityDailyPoint[]> => {
    await assertAdmin(context);
    try {
      const toEnd = `${data.to}T23:59:59.999Z`;

      // 1) Baseline: last known level per patient strictly BEFORE `from`.
      //    Cheap enough to pull all history <from and reduce in-memory.
      const { data: baselineRows, error: bErr } = await context.supabase
        .from("patient_acuity_history")
        .select("partner_patient_id, level, recorded_at")
        .lt("recorded_at", `${data.from}T00:00:00.000Z`)
        .order("recorded_at", { ascending: true })
        .limit(50000);
      if (bErr) throw bErr;

      const state = new Map<string, number | null>();
      for (const r of baselineRows ?? []) {
        state.set(r.partner_patient_id as string, r.level as number | null);
      }

      // 2) In-range events.
      const { data: rangeRows, error: rErr } = await context.supabase
        .from("patient_acuity_history")
        .select("partner_patient_id, level, source, recorded_at")
        .gte("recorded_at", `${data.from}T00:00:00.000Z`)
        .lte("recorded_at", toEnd)
        .order("recorded_at", { ascending: true })
        .limit(50000);
      if (rErr) throw rErr;

      // Bucket events by day.
      const byDay = new Map<
        string,
        Array<{ partner_patient_id: string; level: number | null; source: string }>
      >();
      for (const r of rangeRows ?? []) {
        const k = dayKey(new Date(r.recorded_at as string));
        const arr = byDay.get(k) ?? [];
        arr.push({
          partner_patient_id: r.partner_patient_id as string,
          level: r.level as number | null,
          source: r.source as string,
        });
        byDay.set(k, arr);
      }

      const days = eachDay(data.from, data.to);
      const out: AcuityDailyPoint[] = [];
      for (const day of days) {
        const events = byDay.get(day) ?? [];
        let scored = 0;
        for (const ev of events) {
          if (ev.source === "change" && ev.level != null) scored += 1;
          state.set(ev.partner_patient_id, ev.level);
        }
        // Snapshot end-of-day state.
        const counts = [0, 0, 0, 0];
        let total = 0;
        let sum = 0;
        for (const lvl of state.values()) {
          if (lvl == null) continue;
          if (lvl >= 0 && lvl <= 3) {
            counts[lvl] += 1;
            total += 1;
            sum += lvl;
          }
        }
        out.push({
          date: day,
          scored,
          l0: counts[0],
          l1: counts[1],
          l2: counts[2],
          l3: counts[3],
          patientsScored: total,
          meanAcuity: total === 0 ? null : Math.round((sum / total) * 100) / 100,
        });
      }
      return out;
    } catch (err) {
      throw safeError(
        "analytics.getAcuityAnalytics",
        err,
        "Could not load acuity analytics.",
      );
    }
  });
