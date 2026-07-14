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
 * Toggle wardable status for a partner patient. Preserves the original
 * `wardable_at` timestamp across repeat "wardable=true" writes so the
 * running timer measures true elapsed time from first declaration.
 */
export const setWardableStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => setSchema.parse(d))
  .handler(async ({ data, context }): Promise<WardableStatus> => {
    const { data: existing, error: readErr } = await context.supabase
      .from("patient_wardable_status")
      .select("wardable, wardable_at")
      .eq("partner_patient_id", data.partner_patient_id)
      .maybeSingle();
    if (readErr) throw safeError("wardable", readErr, "Could not read wardable status");

    const nowIso = new Date().toISOString();
    const wardable_at = data.wardable
      ? (existing?.wardable && existing.wardable_at ? existing.wardable_at : nowIso)
      : null;

    const { data: row, error } = await context.supabase
      .from("patient_wardable_status")
      .upsert(
        {
          partner_patient_id: data.partner_patient_id,
          wardable: data.wardable,
          wardable_at,
          updated_by: context.userId,
          updated_at: nowIso,
        },
        { onConflict: "partner_patient_id" },
      )
      .select("partner_patient_id, wardable, wardable_at, updated_at")
      .single();
    if (error) throw safeError("wardable", error, "Could not update wardable status");

    // Best-effort forward to the partner app so the same flag surfaces on
    // their side. Silent failure — the local record is the source of truth
    // for the discharge-latency timer.
    try {
      const { pushWardableToPartner } = await import("./wardable-status.server");
      await pushWardableToPartner({
        partner_patient_id: data.partner_patient_id,
        wardable: data.wardable,
        wardable_at,
        userId: context.userId,
        claims: context.claims as Record<string, unknown>,
      });
    } catch (err) {
      console.warn("[wardable] partner push failed", err);
    }

    return row as WardableStatus;
  });
