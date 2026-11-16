import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Read the partner ICU Handover Hub's composite bed board over the signed
 * cross-project bridge. The partner exposes `/api/public/bridge/beds` which
 * returns the whole bed board in one payload (roster + occupants + stats).
 *
 * We use this instead of the per-table pull (bed_occupancies / bed_outliers /
 * bed_transfers_out) because the partner does not yet expose those three
 * endpoints — see docs/partner-bridge-handoff.md. When it does, the pg_cron
 * sync will populate the local tables and the bed board can revert to
 * getBedBoard() in beds.functions.ts.
 */

export type {
  PartnerOccupant,
  PartnerBedSlot,
  PartnerBedBoardOk,
  PartnerBedBoardFailure,
  PartnerBedBoardResult,
} from "./partner-bed-board-contract";
export { mapPartnerPayload } from "./partner-bed-board-contract";
import type { PartnerOccupant, PartnerBedBoardResult } from "./partner-bed-board-contract";
import type { BoardAccessContext } from "./partner-bed-board.server";

/**
 * Signed read of the partner board for the signed-in caller. The server
 * checks the caller's clinical role (admin | clinician, via
 * has_clinical_access) BEFORE the HMAC-signed admin-actor request is built;
 * denial returns `{ ok:false, forbidden:true }` with no upstream call.
 */
export const getPartnerBedBoard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PartnerBedBoardResult> => {
    const { loadPartnerBedBoardForCaller } = await import("@/lib/partner-bed-board.server");
    return loadPartnerBedBoardForCaller(context as unknown as BoardAccessContext);
  });

// ============================================================================
// Write path — edit a patient on the partner via POST /bridge/patients.
// The partner's authorize() accepts admin or clinician as write roles; we
// require has_clinical_access on our side and forward the signed-in user's
// identity as the actor in the HMAC envelope.
// ============================================================================

export type UpdatePartnerPatientInput = {
  id: string;
  expected_updated_at: string | null;
  full_name?: string | null;
  hospital_number?: string | null;
  age?: number | null;
  bed?: string | null;
  status?: "referred" | "admitted" | "discharged" | "died";
  tep_in_place?: boolean;
  tep_details?: string | null;
  dnacpr_decision?: boolean;
  dnacpr_details?: string | null;
  outstanding_tasks?: string | null;
  // Extended handover fields — used by the referral-prefill flow to seed the
  // partner handover form when a referred patient is first admitted. Kept
  // optional so nothing changes for callers that only edit the basic set.
  past_medical_history?: string | null;
  current_admission?: string | null;
  current_management?: string | null;
};

export type UpdatePartnerPatientResult =
  | { ok: true; patient: PartnerOccupant }
  | {
      ok: false;
      error: string;
      status?: number;
      conflict?: {
        current: PartnerOccupant;
        your_expected_updated_at: string | null;
      };
    };

export const updatePartnerPatient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: UpdatePartnerPatientInput) => {
    if (!data || typeof data !== "object" || typeof data.id !== "string" || !data.id) {
      throw new Error("id is required");
    }
    const normStr = (v: unknown) =>
      v === undefined
        ? undefined
        : v === null || (typeof v === "string" && v.trim() === "")
          ? null
          : String(v);
    const age =
      data.age === undefined
        ? undefined
        : data.age === null || (typeof data.age === "string" && data.age === "")
          ? null
          : Number(data.age);
    if (age !== undefined && age !== null && (!Number.isFinite(age) || age < 0 || age > 130)) {
      throw new Error("age must be between 0 and 130");
    }
    if (
      data.status !== undefined &&
      !["referred", "admitted", "discharged", "died"].includes(data.status)
    ) {
      throw new Error("invalid status");
    }
    return {
      id: data.id,
      expected_updated_at: data.expected_updated_at ?? null,
      full_name: normStr(data.full_name),
      hospital_number: normStr(data.hospital_number),
      age,
      bed: normStr(data.bed),
      status: data.status,
      tep_in_place: typeof data.tep_in_place === "boolean" ? data.tep_in_place : undefined,
      tep_details: normStr(data.tep_details),
      dnacpr_decision:
        typeof data.dnacpr_decision === "boolean" ? data.dnacpr_decision : undefined,
      dnacpr_details: normStr(data.dnacpr_details),
      outstanding_tasks: normStr(data.outstanding_tasks),
      past_medical_history: normStr(data.past_medical_history),
      current_admission: normStr(data.current_admission),
      current_management: normStr(data.current_management),
    } satisfies UpdatePartnerPatientInput;
  })
  .handler(async ({ data, context }): Promise<UpdatePartnerPatientResult> => {
    const { writePartnerPatient } = await import("./partner-patient-write.server");
    let secret = "";
    try {
      const { getBridgeSecrets } = await import("@/lib/bridge-hmac.server");
      secret = getBridgeSecrets().current;
    } catch {
      secret = "";
    }
    return writePartnerPatient(data, {
      userId: context.userId,
      claims: context.claims as Record<string, unknown>,
      checkClinical: async () => {
        const { data: allowed, error } = await context.supabase.rpc("has_clinical_access", { _user_id: context.userId });
        return error ? "error" : allowed === true;
      },
    }, { baseUrl: process.env.PARTNER_BRIDGE_URL, secret });
  });



