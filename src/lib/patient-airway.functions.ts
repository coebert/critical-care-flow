import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Read the airway management type recorded on the partner-mirrored
 * `patients` table. Used by the bed board to render a tracheostomy
 * indicator when the partner records `airway_type === "tracheostomy"`.
 *
 * The value flows in from the ICU Handover Hub via the scheduled bridge
 * pull — see `src/routes/api/public/bridge/sync.ts`. We surface it via a
 * dedicated function rather than widening the partner `/bridge/beds`
 * response so the change is entirely on our side.
 */
export type PatientAirwayEntry = {
  partner_patient_id: string;
  airway_type: string | null;
};

export const getPatientAirways = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PatientAirwayEntry[]> => {
    const { data, error } = await context.supabase
      .from("patients")
      .select("id, airway_type")
      // Bed-board patients are always active ICU records; a NULL filter
      // keeps the payload small without hiding anyone with a trache set.
      .not("airway_type", "is", null);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => ({
      partner_patient_id: (r as { id: string }).id,
      airway_type: (r as { airway_type: string | null }).airway_type ?? null,
    }));
  });
