import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";

const shiftEnum = z.enum(["day", "night"]);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "shift_date must be YYYY-MM-DD");

const upsertSchema = z.object({
  shift_date: dateSchema,
  shift: shiftEnum,
  available_nurses: z.number().min(0).max(200),
  notes: z.string().trim().max(500).nullable().optional(),
});

const listSchema = z.object({
  shift_date: dateSchema,
});

export const getNurseStaffingForDate = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { shift_date: string }) => listSchema.parse(input))
  .handler(async ({ context, data }) => {
    try {
      const { data: rows, error } = await context.supabase
        .from("nurse_staffing")
        .select("id, shift_date, shift, available_nurses, notes, recorded_by, updated_at")
        .eq("shift_date", data.shift_date);
      if (error) throw error;
      return rows ?? [];
    } catch (e) {
      throw safeError("nurse-staffing.list", e, "Failed to load nurse staffing");
    }
  });

export const upsertNurseStaffing = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: z.infer<typeof upsertSchema>) => upsertSchema.parse(input))
  .handler(async ({ context, data }) => {
    try {
      const { data: row, error } = await context.supabase
        .from("nurse_staffing")
        .upsert(
          {
            shift_date: data.shift_date,
            shift: data.shift,
            available_nurses: data.available_nurses,
            notes: data.notes ?? null,
            recorded_by: context.userId,
          },
          { onConflict: "shift_date,shift" },
        )
        .select("id, shift_date, shift, available_nurses, notes, recorded_by, updated_at")
        .single();
      if (error) throw error;
      return row;
    } catch (e) {
      throw safeError("nurse-staffing.upsert", e, "Failed to save nurse staffing");
    }
  });

import { aggregateNurseCapacitySeries } from "./nurse-capacity-analytics";
import { assertAdmin } from "./auth-guards";

const analyticsRangeSchema = z.object({
  from: dateSchema,
  to: dateSchema,
});

export const getNurseCapacityAnalytics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: z.infer<typeof analyticsRangeSchema>) => analyticsRangeSchema.parse(input))
  .handler(async ({ context, data }) => {
    try {
      await assertAdmin(context);
      // Staffing rows in the requested calendar range.
      const { data: staffing, error: sErr } = await context.supabase
        .from("nurse_staffing")
        .select("shift_date, shift, available_nurses")
        .gte("shift_date", data.from)
        .lte("shift_date", data.to);
      if (sErr) throw sErr;

      // Any stay whose active window overlaps [from, to+1day).
      const toExclusive = new Date(`${data.to}T00:00:00`);
      toExclusive.setDate(toExclusive.getDate() + 2); // include night sample of last date
      const fromInclusive = `${data.from}T00:00:00Z`;
      const { data: stays, error: oErr } = await context.supabase
        .from("bed_occupancies")
        .select("admitted_at, discharged_at, level")
        .lt("admitted_at", toExclusive.toISOString())
        .or(`discharged_at.is.null,discharged_at.gte.${fromInclusive}`);
      if (oErr) throw oErr;

      return aggregateNurseCapacitySeries({
        from: data.from,
        to: data.to,
        stays: (stays ?? []).map((s) => ({
          admitted_at: s.admitted_at,
          discharged_at: s.discharged_at,
          level: s.level,
        })),
        staffing: (staffing ?? []).map((r) => ({
          shift_date: r.shift_date,
          shift: r.shift as "day" | "night",
          available_nurses: Number(r.available_nurses),
        })),
      });
    } catch (e) {
      throw safeError("nurse-staffing.analytics", e, "Failed to load nurse capacity analytics");
    }
  });
