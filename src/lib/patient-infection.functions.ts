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
