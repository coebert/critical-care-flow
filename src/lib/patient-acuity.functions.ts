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
  one_to_one: boolean;
  updated_at: string;
  updated_by: string | null;
};

export const getPatientAcuity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AcuityEntry[]> => {
    const { data, error } = await context.supabase
      .from("patient_acuity_overrides")
      .select("partner_patient_id, level, one_to_one, updated_at, updated_by");
    if (error) throw new Error(error.message);
    return (data ?? []) as AcuityEntry[];
  });

export type SetPatientAcuityInput = {
  partner_patient_id: string;
  // When both `level` is null and `one_to_one` is false/omitted, the override
  // is cleared. When `level` is omitted, the existing level is preserved.
  level?: AcuityLevel | null;
  one_to_one?: boolean;
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
    if (
      data.level !== undefined &&
      data.level !== null &&
      ![0, 1, 2, 3].includes(data.level as number)
    ) {
      throw new Error("level must be 0, 1, 2, 3, or null");
    }
    if (data.one_to_one !== undefined && typeof data.one_to_one !== "boolean") {
      throw new Error("one_to_one must be a boolean");
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

    // Merge with any existing row so callers can toggle just level or just 1:1.
    const { data: existing } = await context.supabase
      .from("patient_acuity_overrides")
      .select("level, one_to_one")
      .eq("partner_patient_id", data.partner_patient_id)
      .maybeSingle();

    const nextLevel =
      data.level === undefined
        ? (existing?.level ?? null)
        : data.level;
    const nextOneToOne =
      data.one_to_one === undefined
        ? (existing?.one_to_one ?? false)
        : data.one_to_one;

    // Row is cleared when there's nothing left to record.
    if (nextLevel === null && !nextOneToOne) {
      const { error } = await context.supabase
        .from("patient_acuity_overrides")
        .delete()
        .eq("partner_patient_id", data.partner_patient_id);
      if (error) return { ok: false, error: error.message };
      return { ok: true, entry: null };
    }

    // Level is NOT NULL on the underlying table. If a caller flags 1:1 for a
    // patient that has never had a level scored, default to L1 so the row is
    // valid; clinicians can adjust the level from the same dialog.
    const levelToStore: AcuityLevel = (nextLevel ?? 1) as AcuityLevel;

    const { data: row, error } = await context.supabase
      .from("patient_acuity_overrides")
      .upsert(
        {
          partner_patient_id: data.partner_patient_id,
          level: levelToStore,
          one_to_one: nextOneToOne,
          updated_by: context.userId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "partner_patient_id" },
      )
      .select("partner_patient_id, level, one_to_one, updated_at, updated_by")
      .single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, entry: row as AcuityEntry };
  });

