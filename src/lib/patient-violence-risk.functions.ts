import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";

/**
 * User-toggleable "potentially violent or aggressive" flag for a patient.
 * Stored locally keyed by partner_patient_id so the flag survives bed moves
 * and admissions. Any signed-in clinician can toggle it.
 */
export type PatientViolenceRisk = {
  partner_patient_id: string;
  violence_risk: boolean;
  note: string | null;
  updated_at: string;
};

const COLS = "partner_patient_id, violence_risk, note, updated_at";

export const listViolenceRisk = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PatientViolenceRisk[]> => {
    const { data, error } = await context.supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from("patient_violence_risk" as any)
      .select(COLS);
    if (error)
      throw safeError("violence-risk", error, "Could not load violence risk flags");
    return (data ?? []) as unknown as PatientViolenceRisk[];
  });

const setSchema = z.object({
  partner_patient_id: z.string().min(1).max(200),
  violence_risk: z.boolean(),
  note: z.string().max(500).optional().nullable(),
});

export const setViolenceRisk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => setSchema.parse(d))
  .handler(async ({ data, context }): Promise<PatientViolenceRisk> => {
    const nowIso = new Date().toISOString();
    const { data: row, error } = await context.supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from("patient_violence_risk" as any)
      .upsert(
        {
          partner_patient_id: data.partner_patient_id,
          violence_risk: data.violence_risk,
          note: data.note ?? null,
          updated_by: context.userId,
          updated_at: nowIso,
        },
        { onConflict: "partner_patient_id" },
      )
      .select(COLS)
      .single();
    if (error)
      throw safeError("violence-risk", error, "Could not update violence risk flag");
    return row as unknown as PatientViolenceRisk;
  });
