import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";

/**
 * User-toggleable "end of life care" flag for a patient. Stored locally
 * keyed by partner_patient_id so the flag survives bed moves.
 */
export type PatientEndOfLife = {
  partner_patient_id: string;
  end_of_life: boolean;
  note: string | null;
  updated_at: string;
};

const COLS = "partner_patient_id, end_of_life, note, updated_at";

export const listEndOfLife = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PatientEndOfLife[]> => {
    const { data, error } = await context.supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from("patient_end_of_life" as any)
      .select(COLS);
    if (error)
      throw safeError("end-of-life", error, "Could not load end-of-life flags");
    return (data ?? []) as unknown as PatientEndOfLife[];
  });

const setSchema = z.object({
  partner_patient_id: z.string().min(1).max(200),
  end_of_life: z.boolean(),
  note: z.string().max(500).optional().nullable(),
});

export const setEndOfLife = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => setSchema.parse(d))
  .handler(async ({ data, context }): Promise<PatientEndOfLife> => {
    const nowIso = new Date().toISOString();
    const { data: row, error } = await context.supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from("patient_end_of_life" as any)
      .upsert(
        {
          partner_patient_id: data.partner_patient_id,
          end_of_life: data.end_of_life,
          note: data.note ?? null,
          updated_by: context.userId,
          updated_at: nowIso,
        },
        { onConflict: "partner_patient_id" },
      )
      .select(COLS)
      .single();
    if (error)
      throw safeError("end-of-life", error, "Could not update end-of-life flag");
    return row as unknown as PatientEndOfLife;
  });
