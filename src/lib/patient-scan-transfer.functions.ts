import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";

/**
 * User-toggleable "needs transfer for a scan" flag for a patient. Stored
 * locally keyed by partner_patient_id so the flag survives bed moves.
 */
export type PatientScanTransfer = {
  partner_patient_id: string;
  needs_scan_transfer: boolean;
  note: string | null;
  updated_at: string;
};

const COLS = "partner_patient_id, needs_scan_transfer, note, updated_at";

export const listScanTransfer = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PatientScanTransfer[]> => {
    const { data, error } = await context.supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from("patient_scan_transfer" as any)
      .select(COLS);
    if (error)
      throw safeError("scan-transfer", error, "Could not load scan transfer flags");
    return (data ?? []) as unknown as PatientScanTransfer[];
  });

const setSchema = z.object({
  partner_patient_id: z.string().min(1).max(200),
  needs_scan_transfer: z.boolean(),
  note: z.string().max(500).optional().nullable(),
});

export const setScanTransfer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => setSchema.parse(d))
  .handler(async ({ data, context }): Promise<PatientScanTransfer> => {
    const nowIso = new Date().toISOString();
    const { data: row, error } = await context.supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from("patient_scan_transfer" as any)
      .upsert(
        {
          partner_patient_id: data.partner_patient_id,
          needs_scan_transfer: data.needs_scan_transfer,
          note: data.note ?? null,
          updated_by: context.userId,
          updated_at: nowIso,
        },
        { onConflict: "partner_patient_id" },
      )
      .select(COLS)
      .single();
    if (error)
      throw safeError("scan-transfer", error, "Could not update scan transfer flag");
    return row as unknown as PatientScanTransfer;
  });
