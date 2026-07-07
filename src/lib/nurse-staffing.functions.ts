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
