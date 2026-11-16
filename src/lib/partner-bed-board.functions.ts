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
    const base = process.env.PARTNER_BRIDGE_URL;
    if (!base) return { ok: false, error: "PARTNER_BRIDGE_URL is not configured" };

    // Only clinicians/admins on our side may write across the bridge.
    const { data: allowed, error: roleErr } = await context.supabase.rpc(
      "has_clinical_access",
      { _user_id: context.userId },
    );
    if (roleErr) return { ok: false, error: `authz check failed: ${roleErr.message}` };
    if (!allowed) return { ok: false, error: "forbidden: clinical role required", status: 403 };

    let secret: string;
    try {
      const { getBridgeSecrets } = await import("@/lib/bridge-hmac.server");
      secret = getBridgeSecrets().current;
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }

    // Forward the caller's identity as the actor. Partner authorize() treats
    // the actor as authentic because it is inside the HMAC envelope.
    const claims = context.claims as Record<string, unknown>;
    const email = typeof claims.email === "string" ? claims.email : undefined;
    const actor = JSON.stringify({ id: context.userId, email, role: "clinician" });

    const bodyObj: Record<string, unknown> = { id: data.id };
    if (data.expected_updated_at) bodyObj.expected_updated_at = data.expected_updated_at;
    for (const key of [
      "full_name",
      "hospital_number",
      "age",
      "bed",
      "status",
      "tep_in_place",
      "tep_details",
      "dnacpr_decision",
      "dnacpr_details",
      "outstanding_tasks",
      "past_medical_history",
      "current_admission",
      "current_management",
    ] as const) {
      const v = (data as Record<string, unknown>)[key];
      if (v !== undefined) bodyObj[key] = v;
    }
    const rawBody = JSON.stringify(bodyObj);

    const timestamp = String(Math.floor(Date.now() / 1000));
    const { createHmac } = await import("node:crypto");
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${actor}.${rawBody}`)
      .digest("hex");

    const url = `${base.replace(/\/$/, "")}/patients`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-timestamp": timestamp,
          "x-actor": actor,
          "x-signature": signature,
          "cache-control": "no-store",
        },
        body: rawBody,
      });
    } catch (err) {
      return { ok: false, error: `partner unreachable: ${(err as Error).message}` };
    }

    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      /* keep null */
    }

    if (res.status === 409) {
      const p = (payload ?? {}) as {
        current?: PartnerOccupant;
        your_expected_updated_at?: string | null;
        message?: string;
      };
      return {
        ok: false,
        status: 409,
        error: p.message ?? "This patient was modified since you loaded it.",
        conflict: p.current
          ? {
              current: p.current,
              your_expected_updated_at: p.your_expected_updated_at ?? null,
            }
          : undefined,
      };
    }

    if (!res.ok) {
      const msg =
        (payload as { error?: string; message?: string } | null)?.error ||
        (payload as { error?: string; message?: string } | null)?.message ||
        res.statusText;
      return { ok: false, status: res.status, error: `partner ${res.status}: ${msg}` };
    }

    const p = payload as { patient?: PartnerOccupant } | null;
    if (!p?.patient) {
      return { ok: false, error: "partner returned no patient row" };
    }
    return { ok: true, patient: p.patient };
  });



