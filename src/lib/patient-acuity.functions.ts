import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Local overlay for per-patient care level (0/1/2/3) on the bed board.
 *
 * The partner ICU Handover Hub `/bridge/beds` payload does not expose an
 * acuity field yet, so we keep this in our project and merge it on read.
 * When the partner starts exposing acuity we can drop this in favour of the
 * partner value.
 */

export type AcuityLevel = 0 | 1 | 2 | 3;

export type AcuityEntry = {
  partner_patient_id: string;
  level: AcuityLevel;
  updated_at: string;
  updated_by: string | null;
};

export const getPatientAcuity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AcuityEntry[]> => {
    const { data, error } = await context.supabase
      .from("patient_acuity_overrides")
      .select("partner_patient_id, level, updated_at, updated_by");
    if (error) throw new Error(error.message);
    return (data ?? []) as AcuityEntry[];
  });

export type SetPatientAcuityInput = {
  partner_patient_id: string;
  level: AcuityLevel | null; // null clears the override
};

export type SetPatientAcuityResult =
  | { ok: true; entry: AcuityEntry | null }
  | { ok: false; error: string };

export const setPatientAcuity = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: SetPatientAcuityInput) => {
    if (!data || typeof data.partner_patient_id !== "string" || !data.partner_patient_id) {
      throw new Error("partner_patient_id is required");
    }
    if (data.level !== null && ![0, 1, 2, 3].includes(data.level as number)) {
      throw new Error("level must be 0, 1, 2, 3, or null");
    }
    return data;
  })
  .handler(async ({ data, context }): Promise<SetPatientAcuityResult> => {
    const { data: allowed, error: roleErr } = await context.supabase.rpc(
      "has_clinical_access",
      { _user_id: context.userId },
    );
    if (roleErr) return { ok: false, error: `authz check failed: ${roleErr.message}` };
    if (!allowed) return { ok: false, error: "forbidden: clinical role required" };

    if (data.level === null) {
      const { error } = await context.supabase
        .from("patient_acuity_overrides")
        .delete()
        .eq("partner_patient_id", data.partner_patient_id);
      if (error) return { ok: false, error: error.message };
      return { ok: true, entry: null };
    }

    const { data: row, error } = await context.supabase
      .from("patient_acuity_overrides")
      .upsert(
        {
          partner_patient_id: data.partner_patient_id,
          level: data.level,
          updated_by: context.userId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "partner_patient_id" },
      )
      .select("partner_patient_id, level, updated_at, updated_by")
      .single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, entry: row as AcuityEntry };
  });
