import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";
import { encryptString, decryptString, hashHospitalNumber } from "./crypto.server";

const bookingSchema = z.object({
  hospital_number: z.string().trim().max(50).nullable().optional(),
  age: z.number().int().min(0).max(130).nullable().optional(),
  sex: z.enum(["male", "female", "other", "unknown"]).nullable().optional(),
  weight_kg: z.number().positive().max(499).nullable().optional(),
  height_cm: z.number().positive().max(299).nullable().optional(),
  bmi: z.number().positive().max(199).nullable().optional(),
  proposed_procedure: z.string().trim().max(2000).nullable().optional(),
  past_medical_history: z.string().trim().max(5000).nullable().optional(),
  past_surgical_history: z.string().trim().max(5000).nullable().optional(),
  social_history: z.string().trim().max(2000).nullable().optional(),
  reason_for_bed: z.string().trim().max(2000).nullable().optional(),
  predicted_level: z.enum(["level_1", "level_2", "level_3"]),
  proposed_surgery_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
});

export type PostopBookingInput = z.infer<typeof bookingSchema>;

const ENC_FIELDS = [
  "proposed_procedure",
  "past_medical_history",
  "past_surgical_history",
  "social_history",
  "reason_for_bed",
] as const;

function encryptPayload(input: PostopBookingInput) {
  const out: Record<string, unknown> = {
    age: input.age ?? null,
    sex: input.sex ?? null,
    weight_kg: input.weight_kg ?? null,
    height_cm: input.height_cm ?? null,
    bmi: input.bmi ?? null,
    predicted_level: input.predicted_level,
    proposed_surgery_date: input.proposed_surgery_date ?? null,
    hospital_number_enc: encryptString(input.hospital_number ?? null),
    hospital_number_hash: hashHospitalNumber(input.hospital_number ?? null),
  };
  for (const k of ENC_FIELDS) {
    out[`${k}_enc`] = encryptString((input as any)[k] ?? null);
  }
  return out;
}

function decryptRow(row: Record<string, any>) {
  const out: Record<string, any> = { ...row };
  out.hospital_number = decryptString(row.hospital_number_enc ?? null);
  for (const k of ENC_FIELDS) {
    out[k] = decryptString(row[`${k}_enc`] ?? null);
    delete out[`${k}_enc`];
  }
  delete out.hospital_number_enc;
  delete out.hospital_number_hash;
  return out;
}

export const createPostopBooking = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => bookingSchema.parse(d))
  .handler(async ({ data, context }) => {
    try {
      const payload = encryptPayload(data);
      const { data: row, error } = await context.supabase
        .from("postop_bookings")
        .insert({ ...payload, created_by: context.userId } as any)
        .select("id")
        .single();
      if (error) throw error;
      return { id: row.id as string };
    } catch (err) {
      throw safeError("createPostopBooking", err, "Could not save post-op booking");
    }

  });

export const listPostopBookings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    try {
      const { data, error } = await context.supabase
        .from("postop_bookings")
        .select("*")
        .is("deleted_at", null)
        .order("proposed_surgery_date", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []).map(decryptRow);
    } catch (err) {
      throw safeError("listPostopBookings", err, "Could not load post-op bookings");
    }
  });
