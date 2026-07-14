import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Read infection status + organism recorded on the partner-mirrored
 * `patients` table. Used by the bed board to render an isolation
 * indicator when `infection_status` is `suspected` or `confirmed`.
 *
 * Mirrors the shape of `getPatientAirways` — the value is populated by
 * the scheduled bridge pull, so no partner-side API changes are needed.
 */
export type PatientInfectionEntry = {
  partner_patient_id: string;
  infection_status: "none" | "suspected" | "confirmed" | "unknown" | null;
  infection_organism: string | null;
};

export const getPatientInfections = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PatientInfectionEntry[]> => {
    const { data, error } = await context.supabase
      .from("patients")
      .select("id, infection_status, infection_organism")
      .in("infection_status", ["suspected", "confirmed"]);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => {
      const row = r as {
        id: string;
        infection_status:
          | "none"
          | "suspected"
          | "confirmed"
          | "unknown"
          | null;
        infection_organism: string | null;
      };
      return {
        partner_patient_id: row.id,
        infection_status: row.infection_status,
        infection_organism: row.infection_organism,
      };
    });
  });
