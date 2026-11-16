import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  ACUITY_SELECT,
  runSetPatientAcuity,
  toAcuityEntry,
  validateAcuityInput,
  type AcuityDb,
  type AcuityEntry,
  type AcuityRow,
  type SetPatientAcuityInput,
  type SetPatientAcuityResult,
} from "./patient-acuity-core";

/**
 * Per-patient care level (0/1/2/3) and 1:1 flag, owned by CCC and merged
 * onto the ICU Handover Hub roster on read. See patient-acuity-core.ts for
 * the fail-closed, field-merging write rules.
 */

export type { AcuityLevel, AcuityEntry, SetPatientAcuityInput, SetPatientAcuityResult } from "./patient-acuity-core";

export const getPatientAcuity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AcuityEntry[]> => {
    const { data, error } = await context.supabase.from("patient_acuity_overrides").select(ACUITY_SELECT);
    if (error) throw new Error("Could not load levels of care");
    return ((data ?? []) as unknown as AcuityRow[]).map((r) => toAcuityEntry(r)!) ;
  });

export const setPatientAcuity = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: SetPatientAcuityInput) => validateAcuityInput(data))
  .handler(async ({ data, context }): Promise<SetPatientAcuityResult> => {
    return runSetPatientAcuity(context.supabase as unknown as AcuityDb, context.userId, data, {
      // Successful, revision-checked save → re-evaluate capacity through the
      // same suppressed-when-uncertain alert path as staffing/bed changes.
      reevaluateCapacity: async () => {
        const [{ supabaseAdmin }, { checkAndAlertNurseCapacity }] = await Promise.all([
          import("@/integrations/supabase/client.server"),
          import("./nurse-capacity-alerts.server"),
        ]);
        await checkAndAlertNurseCapacity(supabaseAdmin);
      },
    });
  });
