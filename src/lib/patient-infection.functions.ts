import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";


/**
 * Read isolation status for currently admitted patients from the local
 * `bed_occupancies` mirror. Any occupancy with `isolation` other than
 * `none` — contact, droplet, or airborne — indicates the patient has (or
 * is suspected of having) an infection and requires isolation. This
 * powers the bed board's infection/isolation badge.
 *
 * We use `patient_id` as the join key because the local `patients` table
 * mirrors the partner ID as its primary key (see `bridge/sync.ts`), so
 * `patient_id` on `bed_occupancies` matches the partner's occupant id
 * used by `PartnerOccupant.id`.
 */
export type PatientIsolationEntry = {
  partner_patient_id: string;
  isolation: "contact" | "droplet" | "airborne";
  isolation_reason: string | null;
};

export const getPatientIsolations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PatientIsolationEntry[]> => {
    const { data, error } = await context.supabase
      .from("bed_occupancies")
      .select("patient_id, isolation, isolation_reason")
      .is("discharged_at", null)
      .in("isolation", ["contact", "droplet", "airborne"]);
    if (error) throw new Error(error.message);
    const seen = new Set<string>();
    const out: PatientIsolationEntry[] = [];
    for (const raw of data ?? []) {
      const row = raw as {
        patient_id: string | null;
        isolation: "contact" | "droplet" | "airborne";
        isolation_reason: string | null;
      };
      if (!row.patient_id || seen.has(row.patient_id)) continue;
      seen.add(row.patient_id);
      out.push({
        partner_patient_id: row.patient_id,
        isolation: row.isolation,
        isolation_reason: row.isolation_reason,
      });
    }
    return out;
  });

/**
 * Update the isolation status of the currently-admitted occupancy for the
 * given partner patient id. Writes to `bed_occupancies.isolation` (and the
 * associated reason) on the live, non-discharged row. Any signed-in
 * clinician can toggle it — RLS applies as usual.
 */
const setIsolationSchema = z.object({
  partner_patient_id: z.string().min(1).max(200),
  isolation: z.enum(["none", "contact", "droplet", "airborne"]),
  isolation_reason: z.string().max(500).nullable().optional(),
});

export const setPatientIsolation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => setIsolationSchema.parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const { error } = await context.supabase
      .from("bed_occupancies")
      .update({
        isolation: data.isolation,
        isolation_reason:
          data.isolation === "none" ? null : (data.isolation_reason ?? null),
        updated_by: context.userId,
      })
      .eq("patient_id", data.partner_patient_id)
      .is("discharged_at", null);
    if (error)
      throw safeError("infection", error, "Could not update isolation status");
    return { ok: true };
  });
