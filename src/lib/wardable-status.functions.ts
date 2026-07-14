import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";

export type WardableStatus = {
  partner_patient_id: string;
  wardable: boolean;
  wardable_at: string | null;
  updated_at: string;
};

/**
 * List wardable status rows for every partner patient we've ever marked.
 * The bed board joins this with the partner-sourced occupants to render
 * the wardable badge + running timer.
 */
export const listWardableStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<WardableStatus[]> => {
    const { data, error } = await context.supabase
      .from("patient_wardable_status")
      .select("partner_patient_id, wardable, wardable_at, updated_at");
    if (error) throw safeError("wardable", error, "Could not load wardable status");
    return (data ?? []) as WardableStatus[];
  });

const setSchema = z.object({
  partner_patient_id: z.string().min(1).max(200),
  wardable: z.boolean(),
});

/**
 * Toggle wardable status for a partner patient. The trigger on
 * patient_wardable_status stamps wardable_at when the flag flips true and
 * clears it when it flips false, so the timer always starts from the
 * moment of first declaration.
 */
export const setWardableStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => setSchema.parse(d))
  .handler(async ({ data, context }): Promise<WardableStatus> => {
    const { data: row, error } = await context.supabase
      .from("patient_wardable_status")
      .upsert(
        {
          partner_patient_id: data.partner_patient_id,
          wardable: data.wardable,
          updated_by: context.userId,
        },
        { onConflict: "partner_patient_id" },
      )
      .select("partner_patient_id, wardable, wardable_at, updated_at")
      .single();
    if (error) throw safeError("wardable", error, "Could not update wardable status");
    return row as WardableStatus;
  });
